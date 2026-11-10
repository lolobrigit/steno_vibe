// Реальные возможности WebGPU. Наличие navigator.gpu ещё ничего не значит:
// адаптера может не быть (чёрный список драйверов, Linux, удалённый рабочий
// стол), а fp16-модели требуют фичи shader-f16. Раньше приложение проверяло
// только 'gpu' in navigator и качало WebGPU-сборку модели вхолостую.

export interface GpuCaps {
  webgpu: boolean
  f16: boolean
}

interface AdapterLike {
  features: { has: (name: string) => boolean }
}

let caps: GpuCaps | null = null
let pending: Promise<GpuCaps> | null = null

export function detectGpu(): Promise<GpuCaps> {
  if (caps) return Promise.resolve(caps)
  if (!pending) {
    pending = (async () => {
      let out: GpuCaps = { webgpu: false, f16: false }
      try {
        const gpu = (navigator as unknown as { gpu?: { requestAdapter: () => Promise<AdapterLike | null> } })
          .gpu
        const adapter = gpu ? await gpu.requestAdapter() : null
        if (adapter) out = { webgpu: true, f16: adapter.features.has('shader-f16') }
      } catch {
        /* нет адаптера */
      }
      caps = out
      return out
    })()
  }
  return pending
}

/** Синхронная оценка: точная после detectGpu(), до того — по наличию API. */
export function hasWebGPU(): boolean {
  if (caps) return caps.webgpu
  return typeof navigator !== 'undefined' && 'gpu' in navigator
}

if (typeof navigator !== 'undefined') void detectGpu()

export function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError')
}

export function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError'
}
