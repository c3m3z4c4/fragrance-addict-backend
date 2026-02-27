import os from 'os';

// ─── Estado de métricas en memoria ───
const metrics = {
  startedAt: Date.now(),
  requests: {
    total: 0,
    byMethod: {},
    byRoute: {},
    byStatus: {},
    timestamps: [] // últimos timestamps para calcular RPM
  },
  responseTimes: {
    total: 0,
    count: 0,
    min: Infinity,
    max: 0,
    recent: [] // últimos 100 tiempos de respuesta
  }
};

// ─── Middleware para recolectar métricas ───
export const metricsMiddleware = (req, res, next) => {
  const start = process.hrtime.bigint();
  const now = Date.now();

  metrics.requests.total++;
  metrics.requests.byMethod[req.method] = (metrics.requests.byMethod[req.method] || 0) + 1;

  // Guardar timestamp para RPM (mantener últimos 5 minutos)
  metrics.requests.timestamps.push(now);
  const fiveMinAgo = now - 5 * 60 * 1000;
  metrics.requests.timestamps = metrics.requests.timestamps.filter(t => t > fiveMinAgo);

  res.on('finish', () => {
    // Tiempo de respuesta en ms
    const duration = Number(process.hrtime.bigint() - start) / 1e6;
    metrics.responseTimes.total += duration;
    metrics.responseTimes.count++;
    metrics.responseTimes.min = Math.min(metrics.responseTimes.min, duration);
    metrics.responseTimes.max = Math.max(metrics.responseTimes.max, duration);

    // Mantener últimos 100
    metrics.responseTimes.recent.push(duration);
    if (metrics.responseTimes.recent.length > 100) {
      metrics.responseTimes.recent.shift();
    }

    // Contar por status group (2xx, 4xx, etc.)
    const statusGroup = `${Math.floor(res.statusCode / 100)}xx`;
    metrics.requests.byStatus[statusGroup] = (metrics.requests.byStatus[statusGroup] || 0) + 1;

    // Contar por ruta (normalizada)
    const route = req.route?.path || req.path.replace(/\/[a-f0-9-]{36}/g, '/:id');
    metrics.requests.byRoute[route] = (metrics.requests.byRoute[route] || 0) + 1;
  });

  next();
};

// ─── Obtener métricas en formato compatible con MetricsDashboard ───
export const getMetrics = () => {
  const now = Date.now();
  const mem = process.memoryUsage();
  const cpus = os.cpus();

  // CPU usage promedio
  const cpuUsage = cpus.reduce((acc, cpu) => {
    const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
    const idle = cpu.times.idle;
    return acc + ((total - idle) / total) * 100;
  }, 0) / cpus.length;

  const loadAvg = os.loadavg();

  // RPM basado en últimos 60 segundos
  const oneMinAgo = now - 60 * 1000;
  const requestsLastMinute = metrics.requests.timestamps.filter(t => t > oneMinAgo).length;

  // Percentiles de tiempo de respuesta
  const sorted = [...metrics.responseTimes.recent].sort((a, b) => a - b);
  const percentile = (p) => {
    if (sorted.length === 0) return 0;
    const idx = Math.floor(sorted.length * p);
    return sorted[Math.min(idx, sorted.length - 1)] || 0;
  };

  const avgLatency = metrics.responseTimes.count > 0
    ? metrics.responseTimes.total / metrics.responseTimes.count
    : 0;

  const toMB = (bytes) => (bytes / 1024 / 1024).toFixed(2);
  const round2 = (n) => Math.round(n * 100) / 100;

  return {
    timestamp: new Date().toISOString(),
    uptime: Math.floor((now - metrics.startedAt) / 1000),
    system: {
      memory: {
        rss: mem.rss,
        heapTotal: mem.heapTotal,
        heapUsed: mem.heapUsed,
        external: mem.external,
        rssMB: toMB(mem.rss),
        heapTotalMB: toMB(mem.heapTotal),
        heapUsedMB: toMB(mem.heapUsed)
      },
      cpu: {
        loadAvg1m: round2(loadAvg[0]),
        loadAvg5m: round2(loadAvg[1]),
        loadAvg15m: round2(loadAvg[2]),
        cores: cpus.length,
        avgPercent: round2(cpuUsage).toString()
      }
    },
    traffic: {
      totalRequests: metrics.requests.total,
      rpm: requestsLastMinute.toString(),
      byMethod: metrics.requests.byMethod,
      byStatus: metrics.requests.byStatus,
      topRoutes: Object.entries(metrics.requests.byRoute)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([route, count]) => ({ route, count }))
    },
    latency: {
      avg: round2(avgLatency).toString(),
      min: metrics.responseTimes.min === Infinity ? '0' : round2(metrics.responseTimes.min).toString(),
      max: round2(metrics.responseTimes.max).toString(),
      p50: round2(percentile(0.5)).toString(),
      p95: round2(percentile(0.95)).toString(),
      p99: round2(percentile(0.99)).toString(),
      samples: metrics.responseTimes.count
    }
  };
};
