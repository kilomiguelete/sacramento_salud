// ══════════════════════════════════════════════════════════════════════════════
//  Sacramento Salud — Google Apps Script
//
//  CONFIGURACIÓN (Proyecto → Propiedades del script):
//    SUPABASE_URL  → https://TUPROYECTO.supabase.co
//    SUPABASE_KEY  → service_role key
//    FOLDER_ID     → 15Ixt6foIZ-P-5HRwPFtfW7n_8ZmRqj5U
// ══════════════════════════════════════════════════════════════════════════════

var MAX_SECONDS = 300; // para antes del timeout de 6 min de Google

// ── Utilidades ────────────────────────────────────────────────────────────────

function toDate(s) {
  return s ? s.substring(0, 10) : null;
}

function toTimestamp(s) {
  if (!s) return null;
  var parts = s.split(' ');
  if (parts.length < 3) return s;
  var d = parts[0], t = parts[1], tz = parts[2];
  return d + 'T' + t + tz[0] + tz.substring(1,3) + ':' + tz.substring(3,5);
}

function avgArr(arr, key) {
  var vals = (arr || []).map(function(x){ return x[key]; }).filter(function(v){ return v != null && !isNaN(v); });
  return vals.length ? vals.reduce(function(a,b){ return a+b; }, 0) / vals.length : null;
}

function sumArr(arr, key) {
  var vals = (arr || []).map(function(x){ return x[key]; }).filter(function(v){ return v != null && !isNaN(v); });
  return vals.length ? vals.reduce(function(a,b){ return a+b; }, 0) : null;
}

// ── Supabase ──────────────────────────────────────────────────────────────────

// onConflict: columna por la que Supabase identifica la fila a ACTUALIZAR.
// Para tablas con una fila por día (sleep_analysis, daily_vitals) hay que pasar
// 'date'. Sin esto, Supabase intenta insertar una fila nueva, choca con la
// restricción de fecha única y rechaza la actualización: los datos se quedaban
// congelados tal como llegaron en la primera exportación del día.
function supabaseUpsert(table, rows, onConflict) {
  if (!rows || rows.length === 0) return;
  var props = PropertiesService.getScriptProperties();
  var url   = props.getProperty('SUPABASE_URL') + '/rest/v1/' + table +
              (onConflict ? '?on_conflict=' + onConflict : '');
  var key   = props.getProperty('SUPABASE_KEY');
  var CHUNK = 200;

  for (var i = 0; i < rows.length; i += CHUNK) {
    var resp = UrlFetchApp.fetch(url, {
      method: 'post',
      headers: {
        'apikey': key,
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal',
      },
      payload: JSON.stringify(rows.slice(i, i + CHUNK)),
      muteHttpExceptions: true,
    });
    // Mostrar en el registro cualquier error de Supabase (antes se perdían)
    var code = resp.getResponseCode();
    if (code >= 300) {
      Logger.log('  ⚠ Supabase ' + table + ' respondió ' + code + ': ' + resp.getContentText().substring(0, 200));
    }
  }
}

function supabaseDelete(table, date) {
  var props = PropertiesService.getScriptProperties();
  var url   = props.getProperty('SUPABASE_URL') + '/rest/v1/' + table + '?date=eq.' + date;
  var key   = props.getProperty('SUPABASE_KEY');
  UrlFetchApp.fetch(url, {
    method: 'delete',
    headers: { 'apikey': key, 'Authorization': 'Bearer ' + key },
    muteHttpExceptions: true,
  });
}

// Registra cada archivo procesado en la tabla sync_log de Supabase
function logSync(fileName, fileModified) {
  var props = PropertiesService.getScriptProperties();
  var url   = props.getProperty('SUPABASE_URL') + '/rest/v1/sync_log';
  var key   = props.getProperty('SUPABASE_KEY');

  UrlFetchApp.fetch(url, {
    method: 'post',
    headers: {
      'apikey': key,
      'Authorization': 'Bearer ' + key,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    payload: JSON.stringify({
      file_name: fileName,
      file_modified: fileModified,
      processed_at: new Date().toISOString(),
    }),
    muteHttpExceptions: true,
  });
}

// ── Procesar un JSON ──────────────────────────────────────────────────────────

function processHealthJson(jsonData) {
  var metrics = (jsonData && jsonData.data && jsonData.data.metrics) ? jsonData.data.metrics : [];

  // Agrupar por nombre de métrica
  var byName = {};
  metrics.forEach(function(m) { byName[m.name] = m.data || []; });

  // Agrupar por fecha (un export puede incluir varios días)
  var byDate = {};
  Object.keys(byName).forEach(function(metricName) {
    byName[metricName].forEach(function(pt) {
      var date = toDate(pt.date);
      if (!date) return;
      if (!byDate[date]) byDate[date] = {};
      if (!byDate[date][metricName]) byDate[date][metricName] = [];
      byDate[date][metricName].push(pt);
    });
  });

  Object.keys(byDate).forEach(function(date) {
    var dm = byDate[date];

    // SpO2
    var spo2Data = dm['blood_oxygen_saturation'] || [];
    if (spo2Data.length) {
      supabaseDelete('spo2_readings', date);
      supabaseUpsert('spo2_readings', spo2Data.map(function(p) {
        return { date: date, measured_at: toTimestamp(p.date), value: p.qty, source: p.source || null };
      }));
    }

    // Sueño (una fila por día → on_conflict=date)
    var sleepData = dm['sleep_analysis'] || [];
    if (sleepData.length) {
      var p = sleepData[0];
      supabaseUpsert('sleep_analysis', [{
        date: date,
        total_sleep: p.totalSleep || null,
        deep:  p.deep  || null,
        rem:   p.rem   || null,
        core:  p.core  || null,
        awake: p.awake || null,
        in_bed: p.inBed || null,
        sleep_start: p.sleepStart ? toTimestamp(p.sleepStart) : null,
        sleep_end:   p.sleepEnd   ? toTimestamp(p.sleepEnd)   : null,
        source: p.source || null,
        updated_at: new Date().toISOString(),
      }], 'date');
    }

    // Vitales diarios (una fila por día → on_conflict=date)
    var rrFirst     = (dm['resting_heart_rate']               || [])[0];
    var breathFirst = (dm['breathing_disturbances']           || [])[0];
    var tempFirst   = (dm['apple_sleeping_wrist_temperature'] || [])[0];
    var hrvArr      =  dm['heart_rate_variability']            || [];
    var rrateArr    =  dm['respiratory_rate']                  || [];
    var stepsArr    =  dm['step_count']                        || [];

    if (rrFirst || breathFirst || hrvArr.length || stepsArr.length || tempFirst || rrateArr.length) {
      var totalSteps = sumArr(stepsArr, 'qty');
      // Solo los campos que SÍ tienen dato, para no machacar con null valores
      // que ya estuvieran guardados.
      var vitalRow = { date: date, updated_at: new Date().toISOString() };
      if (rrFirst)              vitalRow.resting_heart_rate     = rrFirst.qty;
      var hrvAvg = avgArr(hrvArr, 'qty');
      if (hrvAvg != null)       vitalRow.hrv_avg                = hrvAvg;
      if (breathFirst)          vitalRow.breathing_disturbances = breathFirst.qty;
      if (totalSteps != null)   vitalRow.step_count             = Math.round(totalSteps);
      if (tempFirst)            vitalRow.wrist_temperature      = tempFirst.qty;
      var rrateAvg = avgArr(rrateArr, 'qty');
      if (rrateAvg != null)     vitalRow.respiratory_rate_avg   = rrateAvg;
      supabaseUpsert('daily_vitals', [vitalRow], 'date');
    }

    // Frecuencia cardíaca
    var hrData = dm['heart_rate'] || [];
    if (hrData.length) {
      supabaseDelete('heart_rate_readings', date);
      supabaseUpsert('heart_rate_readings', hrData.map(function(p) {
        return {
          date: date,
          measured_at: toTimestamp(p.date),
          min_hr: p.Min || p.min || null,
          max_hr: p.Max || p.max || null,
          avg_hr: p.Avg || p.avg || null,
          source: p.source || null,
        };
      }));
    }

    // Pasos con timestamp (para detectar levantadas nocturnas)
    var stepsDetailData = dm['step_count'] || [];
    if (stepsDetailData.length) {
      supabaseDelete('step_readings', date);
      supabaseUpsert('step_readings', stepsDetailData.map(function(p) {
        return {
          date: date,
          measured_at: toTimestamp(p.date),
          value: p.qty,
          source: p.source || null,
        };
      }));
    }
  });

  return Object.keys(byDate).join(', ');
}

// ══════════════════════════════════════════════════════════════════════════════
//  FUNCIÓN PRINCIPAL
//  Procesa archivos nuevos o modificados, y SIEMPRE los de los últimos 3 días.
//  Si hay varios archivos con el mismo nombre (duplicados en Drive), solo usa
//  el modificado más recientemente.
// ══════════════════════════════════════════════════════════════════════════════

function procesarNuevosArchivos() {
  var startTime = new Date().getTime();
  var props     = PropertiesService.getScriptProperties();
  var folderId  = props.getProperty('FOLDER_ID');

  if (!folderId) {
    Logger.log('ERROR: Falta FOLDER_ID en las propiedades del script.');
    return;
  }

  var processed = JSON.parse(props.getProperty('processed_files') || '{}');
  var folder    = DriveApp.getFolderById(folderId);
  var files     = folder.getFiles();

  // Recoger archivos. Si hay duplicados con el mismo nombre, quedarse solo con
  // el modificado más recientemente (los otros suelen ser copias incompletas).
  var porNombre = {};
  var duplicados = 0;
  while (files.hasNext()) {
    var f = files.next();
    var nombre = f.getName();
    if (nombre.indexOf('HealthAutoExport') !== 0 || nombre.indexOf('.json') === -1) continue;
    if (porNombre[nombre]) {
      duplicados++;
      if (f.getLastUpdated() > porNombre[nombre].getLastUpdated()) porNombre[nombre] = f;
    } else {
      porNombre[nombre] = f;
    }
  }
  var fileList = Object.keys(porNombre).map(function(n) { return porNombre[n]; });

  // Ordenar del más antiguo al más reciente
  fileList.sort(function(a, b) {
    return a.getName().localeCompare(b.getName());
  });

  // Fecha límite: los archivos de los últimos 3 días se reprocesan siempre
  var hace3dias = new Date(new Date().getTime() - 3 * 24 * 60 * 60 * 1000)
                    .toISOString().substring(0, 10);

  var total = fileList.length, procesados = 0, saltados = 0, errores = 0;
  var pendientes = [];

  for (var i = 0; i < fileList.length; i++) {
    var file     = fileList[i];
    var fileId   = file.getId();
    var modified = file.getLastUpdated().toISOString();

    var nombreFecha = (file.getName().match(/\d{4}-\d{2}-\d{2}/) || [''])[0];
    var esReciente = nombreFecha && nombreFecha >= hace3dias;

    // Skip solo si no ha cambiado Y no es de los últimos 3 días
    if (processed[fileId] === modified && !esReciente) {
      saltados++;
      continue;
    }

    // Comprobar tiempo — parar si se acerca el timeout
    var elapsed = (new Date().getTime() - startTime) / 1000;
    if (elapsed > MAX_SECONDS) {
      for (var j = i; j < fileList.length; j++) {
        var pf = fileList[j];
        if (processed[pf.getId()] !== pf.getLastUpdated().toISOString()) {
          pendientes.push(pf.getName());
        }
      }
      break;
    }

    Logger.log('Procesando: ' + file.getName() + ' (' + Math.round(elapsed) + 's)');

    try {
      var content = file.getBlob().getDataAsString('UTF-8');
      var json    = JSON.parse(content);
      var fechas  = processHealthJson(json);
      processed[fileId] = modified;
      logSync(file.getName(), modified);
      procesados++;
      Logger.log('  fechas: ' + fechas);
    } catch (e) {
      errores++;
      Logger.log('  Error: ' + e.message);
    }

    // Guardar progreso después de cada archivo
    props.setProperty('processed_files', JSON.stringify(processed));
  }

  var elapsedFinal = Math.round((new Date().getTime() - startTime) / 1000);

  Logger.log('');
  Logger.log('══════════════════════════════════');
  Logger.log('Archivos totales:   ' + total + (duplicados ? ' (+' + duplicados + ' duplicados ignorados)' : ''));
  Logger.log('Procesados ahora:   ' + procesados);
  Logger.log('Ya estaban al día:  ' + saltados);
  Logger.log('Errores:            ' + errores);
  Logger.log('Tiempo:             ' + elapsedFinal + 's');

  if (pendientes.length > 0) {
    Logger.log('');
    Logger.log('⚠ Timeout alcanzado. Quedan ' + pendientes.length + ' archivos.');
    Logger.log('Vuelve a ejecutar procesarNuevosArchivos para continuar.');
  } else {
    Logger.log('✓ Todo al día.');
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  REPROCESAR TODO (para cargar o reparar el historial completo)
//  Si hace timeout, ejecuta procesarNuevosArchivos() las veces que haga falta.
// ══════════════════════════════════════════════════════════════════════════════

function reprocesarTodo() {
  Logger.log('Borrando caché de archivos procesados…');
  PropertiesService.getScriptProperties().deleteProperty('processed_files');
  Logger.log('Iniciando reprocesado. Si hay timeout, ejecuta procesarNuevosArchivos() para continuar.');
  Logger.log('');
  procesarNuevosArchivos();
}

// ══════════════════════════════════════════════════════════════════════════════
//  TRIGGER — ejecuta esto UNA VEZ para activar la automatización (cada 2 horas)
// ══════════════════════════════════════════════════════════════════════════════

function configurarTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) { ScriptApp.deleteTrigger(t); });

  ScriptApp.newTrigger('procesarNuevosArchivos')
    .timeBased()
    .everyHours(2)
    .create();

  Logger.log('✓ Trigger configurado: cada 2 horas.');
}

// ══════════════════════════════════════════════════════════════════════════════
//  VER ESTADO — cuántos archivos quedan por procesar
// ══════════════════════════════════════════════════════════════════════════════

function verEstado() {
  var props    = PropertiesService.getScriptProperties();
  var folderId = props.getProperty('FOLDER_ID');
  var processed = JSON.parse(props.getProperty('processed_files') || '{}');
  var folder   = DriveApp.getFolderById(folderId);
  var files    = folder.getFiles();

  var total = 0, pendientes = 0;
  while (files.hasNext()) {
    var f = files.next();
    if (f.getName().indexOf('HealthAutoExport') !== 0) continue;
    total++;
    if (processed[f.getId()] !== f.getLastUpdated().toISOString()) pendientes++;
  }

  Logger.log('Total archivos en Drive: ' + total);
  Logger.log('Ya procesados:           ' + (total - pendientes));
  Logger.log('Pendientes:              ' + pendientes);
}

// ══════════════════════════════════════════════════════════════════════════════
//  DIAGNÓSTICO — qué métricas hay realmente en los archivos
// ══════════════════════════════════════════════════════════════════════════════

function diagnosticarMetricas() {
  var props    = PropertiesService.getScriptProperties();
  var folderId = props.getProperty('FOLDER_ID');
  var folder   = DriveApp.getFolderById(folderId);
  var files    = folder.getFiles();

  var fileList = [];
  while (files.hasNext()) {
    var f = files.next();
    if (f.getName().indexOf('HealthAutoExport') === 0 && f.getName().indexOf('.json') > -1) {
      fileList.push(f);
    }
  }
  fileList.sort(function(a, b) { return b.getName().localeCompare(a.getName()); });

  var muestra = fileList.slice(0, 5);
  var metricCount = {};

  Logger.log('Analizando ' + muestra.length + ' archivos recientes…\n');

  muestra.forEach(function(file) {
    Logger.log('── ' + file.getName());
    try {
      var json    = JSON.parse(file.getBlob().getDataAsString('UTF-8'));
      var metrics = (json.data && json.data.metrics) ? json.data.metrics : [];

      metrics.forEach(function(m) {
        var n = m.data ? m.data.length : 0;
        Logger.log('   ' + m.name + ': ' + n + ' puntos' + (m.units ? ' (' + m.units + ')' : ''));
        if (!metricCount[m.name]) metricCount[m.name] = 0;
        if (n > 0) metricCount[m.name]++;
      });
    } catch(e) {
      Logger.log('   ERROR: ' + e.message);
    }
    Logger.log('');
  });

  Logger.log('══ RESUMEN — métricas presentes en los ' + muestra.length + ' archivos:');
  Object.keys(metricCount).sort().forEach(function(name) {
    Logger.log('  ' + metricCount[name] + '/' + muestra.length + '  ' + name);
  });
}

// Inspecciona un archivo concreto por fecha (ej: "2026-10-14")
function diagnosticarDia(fecha) {
  fecha = fecha || '2026-10-14';
  var props    = PropertiesService.getScriptProperties();
  var folderId = props.getProperty('FOLDER_ID');
  var folder   = DriveApp.getFolderById(folderId);
  var files    = folder.getFiles();

  while (files.hasNext()) {
    var file = files.next();
    if (file.getName().indexOf(fecha) === -1) continue;

    Logger.log('Archivo: ' + file.getName());
    Logger.log('Modificado: ' + file.getLastUpdated());
    Logger.log('');

    var json    = JSON.parse(file.getBlob().getDataAsString('UTF-8'));
    var metrics = (json.data && json.data.metrics) ? json.data.metrics : [];

    metrics.forEach(function(m) {
      var n = m.data ? m.data.length : 0;
      var muestra = m.data && m.data[0] ? JSON.stringify(m.data[0]).substring(0, 120) : '–';
      Logger.log(m.name + ' (' + n + ' puntos)');
      Logger.log('  ejemplo: ' + muestra);
    });
    return;
  }
  Logger.log('No se encontró archivo para la fecha: ' + fecha);
}
