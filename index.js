const express = require('express');
const { Pool } = require('pg');
const { google } = require('googleapis');
const { DateTime } = require('luxon'); // Recomendado para manejar zonas horarias fácilmente
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static('public')); // Esto hace que el HTML sea accesible

// 1. Configuración de la Base de Datos
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

// Forzar a que la base de datos trabaje con la zona horaria correcta
pool.on('connect', (client) => {
    client.query("SET timezone = 'America/Montevideo'");
});

// 2. Configuración de Google OAuth2
const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
);

// Helper para obtener el cliente de Google Calendar con los tokens de la DB
async function obtenerCalendarioGoogle() {
    const creds = await pool.query('SELECT * FROM credenciales_google LIMIT 1');
    if (creds.rows.length === 0) return null;

    const { access_token, refresh_token, expiry_date } = creds.rows[0];
    oauth2Client.setCredentials({
        access_token,
        refresh_token,
        expiry_date: parseInt(expiry_date)
    });

    return google.calendar({ version: 'v3', auth: oauth2Client });
}

// --- RUTAS DE AUTENTICACIÓN (Solo se usan una vez para vincular la cuenta) ---

app.get('/auth/google', (req, res) => {
    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: ['https://www.googleapis.com/auth/calendar'],
        prompt: 'consent'
    });
    res.redirect(url);
});

app.get('/oauth2callback', async (req, res) => {
    const { code } = req.query;
    try {
        const { tokens } = await oauth2Client.getToken(code);
        await pool.query(
            'INSERT INTO credenciales_google (access_token, refresh_token, expiry_date) VALUES ($1, $2, $3)',
            [tokens.access_token, tokens.refresh_token, tokens.expiry_date]
        );
        res.send('✅ Autenticación exitosa. Ya puedes cerrar esta ventana.');
    } catch (e) {
        res.status(500).send('❌ Error al obtener tokens');
    }
});

// --- RUTAS DE LA AGENDA ---

// 1. Consultar disponibilidad (Cruza horario laboral + turnos ocupados)
app.get('/disponibilidad', async (req, res) => {
    const { fecha } = req.query; // Formato YYYY-MM-DD
    if (!fecha) return res.status(400).json({ error: 'Falta la fecha' });

    try {
        const fechaConsulta = DateTime.fromISO(fecha, { zone: 'America/Montevideo' });
        const diaSemana = fechaConsulta.weekday % 7; // Ajuste para 0=Domingo, 1=Lunes...

        // A. Buscar horario laboral (Especial o Semanal)
        const especial = await pool.query('SELECT * FROM horarios_especiales WHERE fecha = $1', [fecha]);
        let apertura, cierre;

        if (especial.rows.length > 0) {
            if (especial.rows[0].esta_cerrado) return res.json({ libre: [] });
            apertura = especial.rows[0].hora_apertura;
            cierre = especial.rows[0].hora_cierre;
        } else {
            const semanal = await pool.query('SELECT * FROM horarios_semanales WHERE dia_semana = $1', [diaSemana]);
            if (semanal.rows.length === 0) return res.json({ libre: [] });
            apertura = semanal.rows[0].hora_apertura;
            cierre = semanal.rows[0].hora_cierre;
        }

        // B. Buscar turnos ya ocupados
        const ocupados = await pool.query(
            "SELECT fecha_inicio, fecha_fin FROM turnos WHERE fecha_inicio::date = $1 AND estado != 'cancelado'",
            [fecha]
        );

        res.json({
            horario_atencion: { apertura, cierre },
            turnos_ocupados: ocupados.rows.map(t => ({
                inicio: DateTime.fromJSDate(t.fecha_inicio, { zone: 'America/Montevideo' }).toFormat('HH:mm'),
                fin:    DateTime.fromJSDate(t.fecha_fin,    { zone: 'America/Montevideo' }).toFormat('HH:mm')
            }))
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Función para generar un código de seguimiento único (Ej: 8XJ2P9)
const generarCodigo = () => Math.random().toString(36).substring(2, 8).toUpperCase();

app.post('/agendar', async (req, res) => {
    const { telefono, nombre, fecha_inicio, servicio_id } = req.body;

    if (!telefono || !nombre || !fecha_inicio || !servicio_id) {
        return res.status(400).json({ error: 'Faltan datos obligatorios.' });
    }

    try {
        // 1. Obtener duración del servicio
        const servicioInfo = await pool.query(
            'SELECT nombre, duracion_minutos FROM servicios WHERE id = $1 AND activo = TRUE', 
            [servicio_id]
        );
        if (servicioInfo.rows.length === 0) return res.status(404).json({ error: 'Servicio no encontrado.' });
        
        const { nombre: nombreServicio, duracion_minutos: duracion } = servicioInfo.rows[0];

        // 2. Tiempos propuestos
        const inicioPropuesto = DateTime.fromISO(fecha_inicio, { zone: 'America/Montevideo' });
        const finPropuesto = inicioPropuesto.plus({ minutes: duracion });
        const fechaSolo = inicioPropuesto.toISODate(); // YYYY-MM-DD
        const diaSemana = inicioPropuesto.weekday % 7; // 0=Domingo, 1=Lunes...

        // --- VALIDACIÓN 1: ¿ESTÁ DENTRO DEL HORARIO LABORAL? ---
        
        // Buscamos si hay horario especial o semanal
        const especial = await pool.query('SELECT * FROM horarios_especiales WHERE fecha = $1', [fechaSolo]);
        let apertura, cierre;

        if (especial.rows.length > 0) {
            if (especial.rows[0].esta_cerrado) return res.status(403).json({ error: 'La barbería está cerrada este día.' });
            apertura = especial.rows[0].hora_apertura;
            cierre = especial.rows[0].hora_cierre;
        } else {
            const semanal = await pool.query('SELECT * FROM horarios_semanales WHERE dia_semana = $1', [diaSemana]);
            if (semanal.rows.length === 0) return res.status(403).json({ error: 'El barbero no trabaja este día.' });
            apertura = semanal.rows[0].hora_apertura;
            cierre = semanal.rows[0].hora_cierre;
        }

        // Convertimos apertura/cierre (strings de la DB) a objetos DateTime para comparar
        const aperturaDT = DateTime.fromISO(`${fechaSolo}T${apertura}`, { zone: 'America/Montevideo' });
        const cierreDT = DateTime.fromISO(`${fechaSolo}T${cierre}`, { zone: 'America/Montevideo' });

        if (inicioPropuesto < aperturaDT || finPropuesto > cierreDT) {
            return res.status(400).json({ 
                error: `Horario fuera de jornada. El horario para este día es de ${apertura.substring(0,5)} a ${cierre.substring(0,5)}.` 
            });
        }

        // --- VALIDACIÓN 2: ¿HAY SOLAPAMIENTO CON OTROS TURNOS? ---
        
        const consultaChoque = `
            SELECT id FROM turnos 
            WHERE estado = 'confirmado' 
            AND (fecha_inicio < $2 AND fecha_fin > $1)
        `;
        const choque = await pool.query(consultaChoque, [inicioPropuesto.toJSDate(), finPropuesto.toJSDate()]);

        if (choque.rows.length > 0) {
            return res.status(409).json({ error: 'Este horario ya está ocupado por otro cliente.' });
        }

        // --- TODO OK, PROCEDEMOS A GUARDAR ---

        // 3. Cliente
        let cliente = await pool.query('SELECT id FROM clientes WHERE telefono = $1', [telefono]);
        let clienteId = cliente.rows.length > 0 ? cliente.rows[0].id : (await pool.query('INSERT INTO clientes (telefono, nombre) VALUES ($1, $2) RETURNING id', [telefono, nombre])).rows[0].id;

        const codigo = generarCodigo();

        // 4. Google Calendar
        const calendar = await obtenerCalendarioGoogle();
        let googleEventoId = null;
        if (calendar) {
            try {
                const event = await calendar.events.insert({
                    calendarId: 'primary',
                    requestBody: {
                        summary: `${nombreServicio}: ${nombre}`,
                        start: { dateTime: inicioPropuesto.toISO() },
                        end: { dateTime: finPropuesto.toISO() },
                    },
                });
                googleEventoId = event.data.id;
            } catch (e) { console.error("Error en Google Calendar"); }
        }

        // 5. Insertar Turno
        const nuevoTurno = await pool.query(
            `INSERT INTO turnos (cliente_id, servicio_id, fecha_inicio, fecha_fin, google_evento_id, codigo_seguimiento, estado) 
             VALUES ($1, $2, $3, $4, $5, $6, 'confirmado') RETURNING *`,
            [clienteId, servicio_id, inicioPropuesto.toJSDate(), finPropuesto.toJSDate(), googleEventoId, codigo]
        );

        res.status(201).json({
            mensaje: 'Turno confirmado con éxito',
            codigo_seguimiento: codigo,
            detalle: {
                inicio: inicioPropuesto.toFormat('HH:mm'),
                fin: finPropuesto.toFormat('HH:mm'),
                servicio: nombreServicio
            }
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

app.patch('/reagendar', async (req, res) => {
    const { codigo_seguimiento, telefono, nueva_fecha_inicio } = req.body;

    // 1. Validaciones básicas de entrada
    if (!codigo_seguimiento || !telefono || !nueva_fecha_inicio) {
        return res.status(400).json({ error: 'Faltan datos (codigo_seguimiento, telefono o nueva_fecha_inicio).' });
    }

    try {
        // 2. Buscar el turno original y verificar que pertenezca al teléfono
        const queryTurno = `
            SELECT t.*, s.duracion_minutos, s.nombre as servicio_nombre
            FROM turnos t 
            JOIN clientes c ON t.cliente_id = c.id 
            JOIN servicios s ON t.servicio_id = s.id
            WHERE t.codigo_seguimiento = $1 AND c.telefono = $2 AND t.estado = 'confirmado'
        `;
        const resultado = await pool.query(queryTurno, [codigo_seguimiento, telefono]);

        if (resultado.rows.length === 0) {
            return res.status(404).json({ error: 'No se encontró un turno activo con ese código y teléfono.' });
        }

        const turnoOriginal = resultado.rows[0];
        const ahora = DateTime.now().setZone('America/Montevideo');
        const inicioActual = DateTime.fromJSDate(turnoOriginal.fecha_inicio, { zone: 'America/Montevideo' });

        // 3. REGLA DE 1 HORA: Verificar que no sea demasiado tarde para cambiarlo
        if (inicioActual.diff(ahora, 'hours').hours < 1) {
            return res.status(400).json({ error: 'Falta menos de 1 hora para el turno. Por favor, llama a la barbería.' });
        }

        // 4. PREPARAR NUEVA DISPONIBILIDAD
        const nuevoInicio = DateTime.fromISO(nueva_fecha_inicio, { zone: 'America/Montevideo' });
        const nuevoFin = nuevoInicio.plus({ minutes: turnoOriginal.duracion_minutos });

        // 5. VERIFICAR DISPONIBILIDAD (¿Está libre el nuevo horario?)
        const choqueTurnos = await pool.query(
            `SELECT id FROM turnos 
             WHERE estado = 'confirmado' 
             AND id != $1 
             AND (
                 (fecha_inicio < $3 AND fecha_fin > $2)
             )`,
            [turnoOriginal.id, nuevoInicio.toJSDate(), nuevoFin.toJSDate()]
        );

        if (choqueTurnos.rows.length > 0) {
            return res.status(409).json({ error: 'El nuevo horario seleccionado ya está ocupado.' });
        }

        // 6. ACTUALIZAR GOOGLE CALENDAR (Si existe vinculación)
        const calendar = await obtenerCalendarioGoogle();
        if (calendar && turnoOriginal.google_evento_id) {
            try {
                await calendar.events.patch({
                    calendarId: 'primary',
                    eventId: turnoOriginal.google_evento_id,
                    requestBody: {
                        start: { dateTime: nuevoInicio.toISO() },
                        end: { dateTime: nuevoFin.toISO() },
                    },
                });
            } catch (gError) {
                console.error("Error al actualizar Google Calendar:", gError.message);
            }
        }

        // 7. ACTUALIZAR BASE DE DATOS
        await pool.query(
            'UPDATE turnos SET fecha_inicio = $1, fecha_fin = $2 WHERE id = $3',
            [nuevoInicio.toJSDate(), nuevoFin.toJSDate(), turnoOriginal.id]
        );

        res.json({
            mensaje: 'Turno reagendado con éxito',
            detalle: {
                servicio: turnoOriginal.servicio_nombre,
                nueva_fecha: nuevoInicio.toFormat('dd/MM/yyyy'),
                nueva_hora: nuevoInicio.toFormat('HH:mm')
            }
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error interno al intentar reagendar.' });
    }
});

app.patch('/cancelar', async (req, res) => {
    const { codigo_seguimiento, telefono } = req.body;

    if (!codigo_seguimiento || !telefono) {
        return res.status(400).json({ error: 'Faltan datos para cancelar.' });
    }

    try {
        // 1. Buscar el turno y el evento de Google
        const queryTurno = `
            SELECT t.* FROM turnos t 
            JOIN clientes c ON t.cliente_id = c.id 
            WHERE t.codigo_seguimiento = $1 AND c.telefono = $2 AND t.estado = 'confirmado'
        `;
        const resultado = await pool.query(queryTurno, [codigo_seguimiento, telefono]);

        if (resultado.rows.length === 0) {
            return res.status(404).json({ error: 'Turno no encontrado o ya está cancelado.' });
        }

        const turno = resultado.rows[0];
        const ahora = DateTime.now().setZone('America/Montevideo');
        const inicioTurno = DateTime.fromJSDate(turno.fecha_inicio, { zone: 'America/Montevideo' });

        // 2. REGLA DE 1 HORA: No se puede cancelar sobre la hora
        if (inicioTurno.diff(ahora, 'hours').hours < 1) {
            return res.status(400).json({ error: 'Falta menos de 1 hora. Debes llamar para cancelar.' });
        }

        // 3. CANCELAR EN GOOGLE CALENDAR
        const calendar = await obtenerCalendarioGoogle();
        if (calendar && turno.google_evento_id) {
            try {
                await calendar.events.delete({
                    calendarId: 'primary',
                    eventId: turno.google_evento_id
                });
            } catch (gError) {
                console.error("No se pudo borrar de Google, pero seguimos con la DB...");
            }
        }

        // 4. ACTUALIZAR ESTADO EN LA BASE DE DATOS (Borrado lógico)
        await pool.query(
            "UPDATE turnos SET estado = 'cancelado' WHERE id = $1",
            [turno.id]
        );

        res.json({ mensaje: 'Turno cancelado exitosamente. ¡Gracias por avisar!' });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al intentar cancelar.' });
    }
});

// --- ENDPOINTS DE SERVICIOS ---

// A. Obtener todos los servicios activos
app.get('/servicios', async (req, res) => {
    try {
        const resultado = await pool.query(
            'SELECT * FROM servicios WHERE activo = TRUE ORDER BY id ASC'
        );
        res.json(resultado.rows);
    } catch (err) {
        res.status(500).json({ error: 'Error al obtener servicios' });
    }
});

// B. Crear un nuevo servicio
app.post('/servicios', async (req, res) => {
    const { nombre, duracion_minutos, precio } = req.body;
    
    // Validación básica
    if (!nombre || !duracion_minutos) {
        return res.status(400).json({ error: 'Nombre y duración son obligatorios' });
    }

    try {
        const nuevoServicio = await pool.query(
            'INSERT INTO servicios (nombre, duracion_minutos, precio) VALUES ($1, $2, $3) RETURNING *',
            [nombre, duracion_minutos, precio]
        );
        res.status(201).json(nuevoServicio.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Error al crear el servicio' });
    }
});

// C. Desactivar un servicio (Borrado lógico)
app.delete('/servicios/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('UPDATE servicios SET activo = FALSE WHERE id = $1', [id]);
        res.json({ mensaje: 'Servicio desactivado correctamente' });
    } catch (err) {
        res.status(500).json({ error: 'Error al eliminar el servicio' });
    }
});

// 4. Configurar horario especial (Para Luis desde n8n)
app.post('/horario-especial', async (req, res) => {
    const { fecha, apertura, cierre, cerrado } = req.body;
    try {
        await pool.query(
            `INSERT INTO horarios_especiales (fecha, hora_apertura, hora_cierre, esta_cerrado) 
             VALUES ($1, $2, $3, $4) ON CONFLICT (fecha) DO UPDATE SET 
             hora_apertura = EXCLUDED.hora_apertura, hora_cierre = EXCLUDED.hora_cierre, esta_cerrado = EXCLUDED.esta_cerrado`,
            [fecha, apertura, cierre, cerrado]
        );
        res.json({ mensaje: 'Horario actualizado' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 5. Listar turnos para recordatorios (Para que n8n consulte cada hora)
app.get('/recordatorios', async (req, res) => {
    try {
        // Busca turnos que empiecen en exactamente 24 horas (margen de 1 hora)
        const manana = DateTime.now().setZone('America/Montevideo').plus({ days: 1 });
        const turnos = await pool.query(
            `SELECT t.*, c.telefono, c.nombre 
             FROM turnos t JOIN clientes c ON t.cliente_id = c.id 
             WHERE t.fecha_inicio >= $1 AND t.fecha_inicio < $2 AND t.estado = 'confirmado'`,
            [manana.startOf('hour').toJSDate(), manana.endOf('hour').toJSDate()]
        );
        res.json(turnos.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
app.get('/crm/resumen', async (req, res) => {
    const { fecha } = req.query; // Espera YYYY-MM-DD
    try {
        // Cambiá la parte del WHERE en tu consulta de SQL a esto:
const turnos = await pool.query(
    `SELECT t.fecha_inicio, c.nombre, c.telefono, s.nombre as servicio, s.precio 
     FROM turnos t 
     JOIN clientes c ON t.cliente_id = c.id 
     JOIN servicios s ON t.servicio_id = s.id
     WHERE (t.fecha_inicio AT TIME ZONE 'UTC' AT TIME ZONE 'America/Montevideo')::date = $1 
     AND t.estado = 'confirmado' 
     ORDER BY t.fecha_inicio ASC`, [fecha]);

        const ganancias = await pool.query(
            `SELECT SUM(s.precio) as total FROM turnos t 
             JOIN servicios s ON t.servicio_id = s.id 
             WHERE t.fecha_inicio::date = $1 AND t.estado = 'confirmado'`, [fecha]);

        res.json({ hoy: { turnos: turnos.rows, total_recaudado: ganancias.rows[0].total || 0 } });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- ENDPOINTS PARA CONFIGURACIÓN (CRM) ---

// A. Obtener todos los horarios (Semanales y Especiales)
app.get('/crm/horarios', async (req, res) => {
    try {
        const semanales = await pool.query('SELECT * FROM horarios_semanales ORDER BY dia_semana ASC');
        const especiales = await pool.query('SELECT * FROM horarios_especiales WHERE fecha >= CURRENT_DATE ORDER BY fecha ASC');
        res.json({ semanales: semanales.rows, especiales: especiales.rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// B. Actualizar horario semanal (Día a día)
app.put('/crm/horarios-semanales', async (req, res) => {
    const { dia_semana, apertura, cierre } = req.body;
    try {
        await pool.query(
            'UPDATE horarios_semanales SET hora_apertura = $1, hora_cierre = $2 WHERE dia_semana = $3',
            [apertura, cierre, dia_semana]
        );
        res.json({ mensaje: 'Horario actualizado' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// C. Agregar o actualizar horario especial (Excepciones)
app.post('/crm/horarios-especiales', async (req, res) => {
    const { fecha, apertura, cierre, cerrado } = req.body;
    try {
        await pool.query(
            `INSERT INTO horarios_especiales (fecha, hora_apertura, hora_cierre, esta_cerrado) 
             VALUES ($1, $2, $3, $4) 
             ON CONFLICT (fecha) DO UPDATE SET 
             hora_apertura = EXCLUDED.hora_apertura, 
             hora_cierre = EXCLUDED.hora_cierre, 
             esta_cerrado = EXCLUDED.esta_cerrado`,
            [fecha, apertura, cierre, cerrado]
        );
        res.json({ mensaje: 'Excepción guardada' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// D. Turnos de la semana (Resumen)
app.get('/crm/semana', async (req, res) => {
    try {
        const inicio = DateTime.now().setZone('America/Montevideo').startOf('week').toJSDate();
        const fin = DateTime.now().setZone('America/Montevideo').endOf('week').toJSDate();

        const turnos = await pool.query(
            `SELECT t.fecha_inicio, c.nombre, s.nombre as servicio
             FROM turnos t 
             JOIN clientes c ON t.cliente_id = c.id 
             JOIN servicios s ON t.servicio_id = s.id
             WHERE t.fecha_inicio >= $1 AND t.fecha_inicio <= $2 AND t.estado = 'confirmado'
             ORDER BY t.fecha_inicio ASC`, [inicio, fin]);

        res.json(turnos.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`🚀 API de Barbería corriendo en el puerto ${PORT}`);
});