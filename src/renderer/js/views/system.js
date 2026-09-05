import { el, clear, bytes, bytesPerSec, pct, duration, severity } from '../util.js';
import { state, on, loadStaticInfo } from '../state.js';
import { Graph } from '../widgets/graph.js';
import { Ring } from '../widgets/ring.js';

/**
 * Live system dashboard: CPU (total + per core), RAM, GPU, disks, network.
 * Everything redraws from the single `metrics` event so there is exactly one
 * polling loop in the whole app.
 */

function panel(title, children, extraClass = '', headExtra = null) {
  return el('div', { class: `panel bracketed ${extraClass}` }, [
    el('span', { class: 'bracket tl' }), el('span', { class: 'bracket tr' }),
    el('span', { class: 'bracket bl' }), el('span', { class: 'bracket br' }),
    el('div', { class: 'panel-head' }, [
      el('div', { class: 'panel-title', text: title }),
      headExtra
    ]),
    ...[].concat(children)
  ]);
}

function kv(key, valueNode) {
  return el('div', { class: 'kv' }, [
    el('span', { class: 'kv-key', text: key }),
    typeof valueNode === 'string'
      ? el('span', { class: 'kv-val', text: valueNode })
      : valueNode
  ]);
}

function meter(percent, extraClass = '') {
  const wrap = el('div', { class: `meter ${extraClass}` }, [el('i')]);
  wrap.appendChild(el('div', { class: 'meter-ticks' }));
  const bar = wrap.querySelector('i');
  bar.style.width = `${Math.max(0, Math.min(100, percent || 0))}%`;
  return wrap;
}

export function createSystemView() {
  const cpuRing = new Ring({ caption: 'CPU' });
  const ramRing = new Ring({ caption: 'RAM' });
  const gpuRing = new Ring({ caption: 'GPU' });

  const cpuCanvas = el('canvas', { class: 'graph-canvas' });
  const ramCanvas = el('canvas', { class: 'graph-canvas' });
  const netCanvas = el('canvas', { class: 'graph-canvas' });
  const diskCanvas = el('canvas', { class: 'graph-canvas' });

  const cpuGraph = new Graph(cpuCanvas, { color: '#00f0ff', capacity: 100 });
  const ramGraph = new Graph(ramCanvas, { color: '#ff2e88', capacity: 100 });
  const netGraph = new Graph(netCanvas, { color: '#26e08a', color2: '#ffb400', autoScale: true, capacity: 100 });
  const diskGraph = new Graph(diskCanvas, { color: '#8b5cf6', color2: '#4d9fff', autoScale: true, capacity: 100 });

  const cpuDetail = el('div', { class: 'kv-list' });
  const coreGrid = el('div', { class: 'core-grid' });
  const memDetail = el('div', { class: 'kv-list' });
  const gpuDetail = el('div', { class: 'kv-list' });
  const diskList = el('div', {});
  const netDetail = el('div', { class: 'kv-list' });
  const sysDetail = el('div', { class: 'kv-list' });

  const netLegend = el('div', { class: 'row gap-12' }, [
    el('span', { class: 'badge', style: { color: '#26e08a', borderColor: '#26e08a55' }, text: 'Download' }),
    el('span', { class: 'badge', style: { color: '#ffb400', borderColor: '#ffb40055' }, text: 'Upload' })
  ]);

  const diskLegend = el('div', { class: 'row gap-12' }, [
    el('span', { class: 'badge', style: { color: '#8b5cf6', borderColor: '#8b5cf655' }, text: 'Lesen' }),
    el('span', { class: 'badge', style: { color: '#4d9fff', borderColor: '#4d9fff55' }, text: 'Schreiben' })
  ]);

  const view = el('section', { class: 'view', id: 'view-system' }, [
    el('div', { class: 'view-head' }, [
      el('div', {}, [
        el('h2', { class: 'glitch', dataset: { text: 'System' }, text: 'System' }),
        el('div', { class: 'view-sub', dataset: { role: 'sys-sub' }, text: 'Live-Telemetrie' })
      ])
    ]),
    el('div', { class: 'dash-grid' }, [
      panel('Auslastung', [
        el('div', { class: 'ring-row' }, [cpuRing.node, ramRing.node, gpuRing.node])
      ], 'span-4'),

      panel('Prozessor', [cpuCanvas, cpuDetail], 'span-8'),

      panel('Kerne', [coreGrid], 'span-5'),

      panel('Arbeitsspeicher', [ramCanvas, memDetail], 'span-7'),

      panel('Netzwerk', [netCanvas, netDetail], 'span-6', netLegend),

      panel('Datenträger-Aktivität', [diskCanvas], 'span-6', diskLegend),

      panel('Laufwerke', [diskList], 'span-4'),

      panel('Grafik', [gpuDetail], 'span-4'),

      panel('Maschine', [sysDetail], 'span-4')
    ])
  ]);

  /* ------------------------------------------------------------- updating */

  let lastCoreCount = 0;
  const coreBars = [];

  function updateCores(cores) {
    if (cores.length !== lastCoreCount) {
      clear(coreGrid);
      coreBars.length = 0;
      cores.forEach((_, i) => {
        const val = el('span', { class: 'core-val', text: '0%' });
        const bar = meter(0);
        coreGrid.appendChild(el('div', { class: 'core' }, [
          el('span', { class: 'core-id', text: `C${String(i).padStart(2, '0')}` }),
          val,
          bar
        ]));
        coreBars.push({ val, bar: bar.querySelector('i'), wrap: bar });
      });
      lastCoreCount = cores.length;
    }
    cores.forEach((value, i) => {
      const ref = coreBars[i];
      if (!ref) return;
      ref.val.textContent = `${Math.round(value)}%`;
      ref.bar.style.width = `${value}%`;
      ref.wrap.className = `meter ${severity(value)}`;
    });
  }

  function updateDisks(disks) {
    clear(diskList);
    if (!disks || !disks.length) {
      diskList.appendChild(el('div', { class: 'faint', text: 'Keine Laufwerksdaten verfügbar.' }));
      return;
    }
    for (const disk of disks) {
      const used = disk.percent || 0;
      diskList.appendChild(el('div', { class: 'disk-item' }, [
        el('div', { class: 'disk-head' }, [
          el('span', { class: 'disk-name', text: disk.mount || disk.fs }),
          el('span', { class: 'disk-sub', text: `${bytes(disk.used)} / ${bytes(disk.size)} · ${pct(used, 1)}` })
        ]),
        meter(used, severity(used)),
        el('div', { class: 'disk-sub', style: { marginTop: '5px' }, text: `${bytes(disk.available)} frei${disk.type ? ` · ${disk.type}` : ''}` })
      ]));
    }
  }

  function updateStatic(info) {
    if (!info) return;
    clear(sysDetail);
    sysDetail.append(
      kv('Rechner', info.hostname),
      kv('System', info.distro || `${info.platform} ${info.release}`),
      kv('Build', info.build ? String(info.build) : '—'),
      kv('CPU', info.cpuBrand || info.cpuModel),
      kv('Kerne', `${info.physicalCores || '?'} phys. / ${info.cores} logisch`),
      kv('Takt', info.cpuSpeed ? `${info.cpuSpeed} GHz` : '—'),
      kv('Board', info.board || '—'),
      kv('RAM gesamt', bytes(info.totalMem))
    );
    const sub = view.querySelector('[data-role="sys-sub"]');
    if (sub) sub.textContent = `${info.hostname} · ${info.cpuBrand || info.cpuModel}`;
  }

  const SOURCE_LABELS = {
    counters: 'Windows-GPU-Zähler',
    'nvidia-smi': 'nvidia-smi'
  };

  // WMI reports vendors as "Advanced Micro Devices, Inc."; the badge wants AMD.
  function shortVendor(vendor, model) {
    const text = `${vendor || ''} ${model || ''}`.toLowerCase();
    if (/amd|advanced micro|radeon|ati /.test(text)) return 'AMD';
    if (/nvidia|geforce|quadro|rtx |gtx /.test(text)) return 'NVIDIA';
    if (/intel|arc |iris |uhd graphics|hd graphics/.test(text)) return 'Intel';
    if (/microsoft|basic display/.test(text)) return 'Microsoft';
    if (!vendor) return null;
    return String(vendor).split(/[\s,]+/)[0];
  }

  function renderGpu(slow) {
    const adapters = slow.gpu || [];
    clear(gpuDetail);

    if (!adapters.length) {
      gpuRing.set(0, '—');
      gpuDetail.appendChild(el('div', { class: 'faint', style: { fontSize: '12px', lineHeight: '1.6' },
        text: slow.gpuNote || 'Keine Grafikkarte erkannt.' }));
      return;
    }

    const primary = adapters[0];
    gpuRing.set(primary.load != null ? primary.load : 0, primary.load != null ? undefined : '—');

    adapters.forEach((gpu, index) => {
      const block = el('div', { class: 'gpu-block' });

      block.appendChild(el('div', { class: 'gpu-head' }, [
        el('span', { class: 'gpu-model truncate', title: gpu.model || '', text: gpu.model || 'Unbekannt' }),
        (() => {
          const label = shortVendor(gpu.vendor, gpu.model);
          return label ? el('span', { class: 'badge', text: label }) : null;
        })()
      ]));

      if (gpu.load != null) {
        block.appendChild(el('div', { class: 'gpu-load-row' }, [
          el('span', { class: 'gpu-load', text: pct(gpu.load, 0) }),
          meter(gpu.load, severity(gpu.load))
        ]));
      } else {
        block.appendChild(el('div', { class: 'faint', style: { fontSize: '11.5px' }, text: 'Keine Auslastungswerte' }));
      }

      // Per-engine detail is what makes an AMD card readable: a video export
      // pins the encoder while 3D sits idle, and one number hides that.
      const breakdown = gpu.breakdown && Object.entries(gpu.breakdown).filter(([, v]) => v >= 1);
      if (breakdown && breakdown.length) {
        block.appendChild(el('div', { class: 'gpu-engines' }, breakdown
          .sort((a, b) => b[1] - a[1])
          .slice(0, 4)
          .map(([label, value]) => el('span', { class: 'chip', text: `${label} ${Math.round(value)}%` }))));
      }

      const detail = el('div', { class: 'kv-list' });
      if (gpu.memTotal) {
        const usedPct = gpu.memUsed != null ? (gpu.memUsed / gpu.memTotal) * 100 : 0;
        detail.appendChild(kv('Videospeicher',
          `${Math.round(gpu.memUsed || 0)} / ${Math.round(gpu.memTotal)} MB`));
        detail.appendChild(meter(usedPct, severity(usedPct)));
      } else if (gpu.memUsed != null) {
        detail.appendChild(kv('Videospeicher', `${Math.round(gpu.memUsed)} MB`));
      }
      if (gpu.memShared) detail.appendChild(kv('Geteilt', `${Math.round(gpu.memShared)} MB`));
      detail.appendChild(kv('Temperatur', gpu.temp != null ? `${Math.round(gpu.temp)} °C` : '—'));
      if (gpu.fanSpeed != null) detail.appendChild(kv('Lüfter', `${gpu.fanSpeed}%`));
      if (gpu.driver) detail.appendChild(kv('Treiber', gpu.driver));
      block.appendChild(detail);

      if (index === adapters.length - 1) {
        const source = SOURCE_LABELS[gpu.loadSource] || null;
        const parts = [];
        if (source) parts.push(`Auslastung über ${source}`);
        if (gpu.temp == null) parts.push('Temperatur liefern nur NVIDIA-Treiber');
        if (parts.length) {
          block.appendChild(el('div', { class: 'gpu-source', text: `${parts.join(' · ')}.` }));
        }
      }

      gpuDetail.appendChild(block);
    });

    if (slow.gpuNote) {
      gpuDetail.appendChild(el('div', { class: 'gpu-source', style: { color: 'var(--warn)' }, text: slow.gpuNote }));
    }
  }

  function update(sample) {
    if (!sample) return;
    const cpu = sample.cpu || { total: 0, cores: [] };
    const mem = sample.mem || {};
    const slow = sample.slow || {};

    cpuRing.set(cpu.total);
    ramRing.set(mem.percent);

    cpuGraph.push(cpu.total);
    ramGraph.push(mem.percent);
    updateCores(cpu.cores || []);

    clear(cpuDetail);
    cpuDetail.append(
      kv('Auslastung', pct(cpu.total, 1)),
      kv('Kerne aktiv', `${(cpu.cores || []).filter((c) => c > 5).length} / ${(cpu.cores || []).length}`),
      kv('Spitze (Kern)', pct(Math.max(0, ...(cpu.cores || [0])), 1)),
      kv('Temperatur', slow.cpuTemp != null ? `${slow.cpuTemp.toFixed(0)} °C` : '—'),
      kv('Betriebszeit', duration(sample.uptime))
    );

    clear(memDetail);
    memDetail.append(
      kv('Belegt', `${bytes(mem.used)} (${pct(mem.percent, 1)})`),
      kv('Frei', bytes(mem.free)),
      kv('Gesamt', bytes(mem.total))
    );
    memDetail.appendChild(meter(mem.percent, severity(mem.percent)));

    renderGpu(slow);

    if (slow.net) {
      netGraph.push(slow.net.rxSec, slow.net.txSec);
      clear(netDetail);
      netDetail.append(
        kv('Adapter', slow.net.iface || '—'),
        kv('Download', bytesPerSec(slow.net.rxSec)),
        kv('Upload', bytesPerSec(slow.net.txSec)),
        kv('Empfangen gesamt', bytes(slow.net.rxTotal)),
        kv('Gesendet gesamt', bytes(slow.net.txTotal))
      );
    }

    if (slow.diskIO) {
      diskGraph.push(slow.diskIO.readBytesPerSec || 0, slow.diskIO.writeBytesPerSec || 0);
    }

    updateDisks(slow.disks);
  }

  on('metrics', update);
  on('staticInfo', updateStatic);
  if (state.metrics) update(state.metrics);
  if (state.staticInfo) updateStatic(state.staticInfo);
  else loadStaticInfo().catch(() => {});

  return view;
}
