// DSP-примитивы для диаризации: Kaldi-совместимый fbank (80 mel-полос,
// окно Повея 25 мс / шаг 10 мс, CMN по устному высказыванию) — такие признаки
// ждёт модель WeSpeaker ResNet34. Плюс radix-2 FFT и агломеративная
// кластеризация по косинусной близости эмбеддингов спикеров.

export interface FbankResult {
  /** [numFrames * numMelBins], построчно */
  features: Float32Array
  numFrames: number
  numMelBins: number
}

function poveyWindow(n: number): Float32Array {
  // Kaldi "povey": hamming^0.85
  const w = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const h = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))
    w[i] = Math.pow(Math.max(h, 0), 0.85)
  }
  return w
}

function hzToMel(f: number): number {
  return 1127 * Math.log(1 + f / 700)
}

function melToHz(m: number): number {
  return 700 * (Math.exp(m / 1127) - 1)
}

interface MelFilter {
  start: number
  weights: Float32Array
}

function melFilterbank(
  numBins: number,
  fftSize: number,
  sampleRate: number,
  lowFreq = 20,
  highFreq = 0,
): MelFilter[] {
  const numFftBins = fftSize / 2 + 1
  const nyq = highFreq <= 0 ? sampleRate / 2 : Math.min(highFreq, sampleRate / 2)
  const lowMel = hzToMel(lowFreq)
  const highMel = hzToMel(nyq)
  const points: number[] = []
  for (let i = 0; i < numBins + 2; i++) {
    points.push(melToHz(lowMel + ((highMel - lowMel) * i) / (numBins + 1)))
  }
  const filters: MelFilter[] = []
  for (let b = 0; b < numBins; b++) {
    const f0 = points[b]
    const f1 = points[b + 1]
    const f2 = points[b + 2]
    let start = -1
    const weights: number[] = []
    for (let i = 0; i < numFftBins; i++) {
      const f = (i * sampleRate) / fftSize
      let w = 0
      if (f > f0 && f < f2) {
        w = f <= f1 ? (f - f0) / (f1 - f0 || 1e-9) : (f2 - f) / (f2 - f1 || 1e-9)
      }
      if (w > 0) {
        if (start < 0) start = i
        weights.push(w)
      }
    }
    filters.push({ start: Math.max(0, start), weights: Float32Array.from(weights) })
  }
  return filters
}

// Итеративный radix-2 FFT, возвращает мощность первых N/2+1 бинов.
function fftPower(frame: Float32Array, fftSize: number): Float32Array {
  const re = new Float32Array(fftSize)
  const im = new Float32Array(fftSize)
  re.set(frame.subarray(0, Math.min(frame.length, fftSize)))

  // бит-реверсивная перестановка
  for (let i = 1, j = 0; i < fftSize; i++) {
    let bit = fftSize >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]
      re[i] = re[j]
      re[j] = tr
      const ti = im[i]
      im[i] = im[j]
      im[j] = ti
    }
  }

  for (let len = 2; len <= fftSize; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    const half = len >> 1
    for (let i = 0; i < fftSize; i += len) {
      let curR = 1
      let curI = 0
      for (let j = 0; j < half; j++) {
        const uR = re[i + j]
        const uI = im[i + j]
        const vR = re[i + j + half] * curR - im[i + j + half] * curI
        const vI = re[i + j + half] * curI + im[i + j + half] * curR
        re[i + j] = uR + vR
        im[i + j] = uI + vI
        re[i + j + half] = uR - vR
        im[i + j + half] = uI - vI
        const nextR = curR * wr - curI * wi
        curI = curR * wi + curI * wr
        curR = nextR
      }
    }
  }

  const numBins = fftSize / 2 + 1
  const power = new Float32Array(numBins)
  for (let i = 0; i < numBins; i++) power[i] = re[i] * re[i] + im[i] * im[i]
  return power
}

/**
 * Kaldi-style fbank: pre-emphasis 0.97 → окно Повея → 512-FFT → 80 mel-полос
 * (20 Гц .. Найквист) → log → CMN (вычитание среднего по бину).
 */
export function fbank(
  samples: Float32Array,
  sampleRate = 16000,
  numMelBins = 80,
): FbankResult {
  const frameLen = Math.round(0.025 * sampleRate) // 400
  const frameShift = Math.round(0.01 * sampleRate) // 160
  const nFft = nextPow2(frameLen)
  const win = poveyWindow(frameLen)
  const filters = melFilterbank(numMelBins, nFft, sampleRate)
  const numFrames =
    samples.length >= frameLen ? 1 + Math.floor((samples.length - frameLen) / frameShift) : 1
  const features = new Float32Array(numFrames * numMelBins)
  const frame = new Float32Array(frameLen)

  for (let t = 0; t < numFrames; t++) {
    const off = t * frameShift
    frame.fill(0)
    const n = Math.min(frameLen, samples.length - off)
    for (let i = 0; i < n; i++) frame[i] = samples[off + i]
    // remove DC offset (kaldi remove_dc_offset=true)
    let dc = 0
    for (let i = 0; i < frameLen; i++) dc += frame[i]
    dc /= frameLen
    for (let i = 0; i < frameLen; i++) frame[i] -= dc
    // pre-emphasis
    for (let i = frameLen - 1; i > 0; i--) frame[i] -= 0.97 * frame[i - 1]
    frame[0] *= 1 - 0.97
    // окно
    for (let i = 0; i < frameLen; i++) frame[i] *= win[i]
    const power = fftPower(frame, nFft)
    for (let b = 0; b < numMelBins; b++) {
      const f = filters[b]
      let e = 0
      for (let k = 0; k < f.weights.length; k++) e += power[f.start + k] * f.weights[k]
      features[t * numMelBins + b] = Math.log(Math.max(e, 1e-10))
    }
  }

  // CMN
  for (let b = 0; b < numMelBins; b++) {
    let mean = 0
    for (let t = 0; t < numFrames; t++) mean += features[t * numMelBins + b]
    mean /= numFrames
    for (let t = 0; t < numFrames; t++) features[t * numMelBins + b] -= mean
  }

  return { features, numFrames, numMelBins }
}

function nextPow2(n: number): number {
  let p = 1
  while (p < n) p <<= 1
  return p
}

export function cosineSim(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

export function l2Normalize(v: Float32Array): Float32Array {
  let n = 0
  for (let i = 0; i < v.length; i++) n += v[i] * v[i]
  n = Math.sqrt(n)
  const out = new Float32Array(v.length)
  if (n > 0) for (let i = 0; i < v.length; i++) out[i] = v[i] / n
  return out
}

/**
 * Агломеративная кластеризация (average linkage) по косинусной близости.
 * Сливаем, пока лучшая межкластерная близость >= threshold.
 * Возвращает id кластера для каждого элемента (0..k-1 по убыванию размера).
 */
export function clusterEmbeddings(
  embeddings: Float32Array[],
  threshold = 0.7,
  maxClusters = 8,
): number[] {
  const n = embeddings.length
  if (n === 0) return []
  if (n === 1) return [0]

  // попарная близость
  const sim: number[][] = Array.from({ length: n }, () => new Array(n).fill(0))
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      const s = cosineSim(embeddings[i], embeddings[j])
      sim[i][j] = s
      sim[j][i] = s
    }

  // начинаем с singleton-кластеров
  let clusters: number[][] = embeddings.map((_, i) => [i])
  const assign = new Array<number>(n).fill(0)

  const avgSim = (a: number[], b: number[]): number => {
    let s = 0
    for (const i of a) for (const j of b) s += sim[i][j]
    return s / (a.length * b.length)
  }

  for (;;) {
    let bestI = -1
    let bestJ = -1
    let best = -Infinity
    for (let i = 0; i < clusters.length; i++)
      for (let j = i + 1; j < clusters.length; j++) {
        const s = avgSim(clusters[i], clusters[j])
        if (s > best) {
          best = s
          bestI = i
          bestJ = j
        }
      }
    const overCap = clusters.length > maxClusters
    if (bestI < 0 || (best < threshold && !overCap)) break
    clusters[bestI] = clusters[bestI].concat(clusters[bestJ])
    clusters.splice(bestJ, 1)
  }

  // нумеруем кластеры по убыванию размера
  const order = clusters
    .map((c, idx) => ({ idx, size: c.length }))
    .sort((a, b) => b.size - a.size)
  const remap = new Map(order.map((o, newId) => [o.idx, newId]))
  clusters.forEach((c, oldId) => {
    const id = remap.get(oldId) ?? 0
    for (const i of c) assign[i] = id
  })
  return assign
}
