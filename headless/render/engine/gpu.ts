import { createRendererRuntime, type RendererRuntime } from "@rendergl/headless-three-webgpu";
import { float, max, mix, renderOutput, texture, uv, vec3, vec4 } from "three/tsl";
import {
  ACESFilmicToneMapping,
  AgXToneMapping,
  Color,
  HalfFloatType,
  LinearToneMapping,
  NeutralToneMapping,
  NodeMaterial,
  NoToneMapping,
  QuadMesh,
  RenderTarget,
  SRGBColorSpace,
  UnsignedByteType,
  WebGPURenderer,
  type Camera,
  type Scene,
  type ToneMapping,
} from "three/webgpu";

import type { RenderOptions } from "./options";
import { packRows } from "./readback";

const TONE_MAPPINGS: Record<RenderOptions["toneMapping"], ToneMapping> = {
  agx: AgXToneMapping,
  aces: ACESFilmicToneMapping,
  neutral: NeutralToneMapping,
  linear: LinearToneMapping,
  none: NoToneMapping,
};

/** Settings for {@link createFrameRenderer}. */
export interface IFrameRendererOptions {
  width: number;
  height: number;
  /** Internal resolution multiplier; 2 renders 4x the pixels and box-filters them down. */
  supersample: 1 | 2;
  toneMapping: RenderOptions["toneMapping"];
  exposure: number;
  /** Hex background color composited after tone mapping, or undefined for straight-alpha output. */
  background: string | undefined;
}

/** A headless WebGPU renderer that turns a scene and camera into one finished RGBA8 frame. */
export interface IFrameRenderer {
  /** The underlying three.js renderer, for PMREM generation and loaders that need it. */
  readonly renderer: WebGPURenderer;
  /** Renders and reads back one frame: sRGB, straight alpha, top row first, tightly packed. */
  render(scene: Scene, camera: Camera): Promise<Uint8Array>;
  dispose(): Promise<void>;
}

/**
 * Builds the output pass: un-premultiply the MSAA-resolved HDR color, tone map and sRGB-encode it,
 * then composite over the background in display space so the background color is exact.
 */
function createOutputMaterial(hdr: RenderTarget, options: IFrameRendererOptions): NodeMaterial {
  const sample = texture(hdr.texture, uv());
  const alpha = sample.a;
  const straight = sample.rgb.div(max(alpha, float(1e-4)));
  const mapped = renderOutput(vec4(straight, 1), TONE_MAPPINGS[options.toneMapping], SRGBColorSpace).rgb;
  const material = new NodeMaterial();
  if (options.background === undefined) {
    material.fragmentNode = vec4(mapped, alpha);
    return material;
  }
  const background = new Color(options.background).getRGB({ r: 0, g: 0, b: 0 }, SRGBColorSpace);
  material.fragmentNode = vec4(mix(vec3(background.r, background.g, background.b), mapped, alpha), 1);
  return material;
}

/** One Dawn device and three.js renderer, shared by every frame size a process renders. */
export interface IGpu {
  readonly renderer: WebGPURenderer;
  /**
   * Returns a frame renderer for these settings. The targets of the previous settings are freed when
   * the settings change, so a process alternating sizes rebuilds them; the device and its compiled
   * pipelines stay.
   */
  frame(options: IFrameRendererOptions): IFrameRenderer;
  dispose(): Promise<void>;
}

/**
 * Creates the Dawn device and the three.js renderer once per process.
 *
 * Only one Dawn instance may exist per process, so a long-lived process keeps this and asks it for
 * frame renderers; each frame renderer draws into a 4x MSAA half-float target at `supersample` times
 * the output size, then resolves it to 8-bit through a tone-mapping pass.
 */
export async function createGpu(): Promise<IGpu> {
  const runtime: RendererRuntime = await createRendererRuntime();
  const renderer = new WebGPURenderer({ device: runtime.device, antialias: false, alpha: true });
  await renderer.init();
  renderer.shadowMap.enabled = true;
  renderer.setClearColor(0x000000, 0);
  let current: { key: string; frame: IFrameRenderer; free(): void } | undefined;

  const build = (options: IFrameRendererOptions) => {
    const scale = options.supersample;
    const hdr = new RenderTarget(options.width * scale, options.height * scale, { type: HalfFloatType, samples: 4 });
    const ldr = new RenderTarget(options.width, options.height, { type: UnsignedByteType });
    const outputMaterial = createOutputMaterial(hdr, options);
    const quad = new QuadMesh(outputMaterial);
    const frame: IFrameRenderer = {
      renderer,
      async render(scene, camera) {
        renderer.toneMappingExposure = options.exposure;
        renderer.setRenderTarget(hdr);
        renderer.render(scene, camera);
        renderer.setRenderTarget(ldr);
        quad.render(renderer);
        renderer.setRenderTarget(null);
        const pixels = await renderer.readRenderTargetPixelsAsync(ldr, 0, 0, options.width, options.height);
        const bytes = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
        return packRows(bytes, options.width, options.height);
      },
      // Freed by the shared GPU when the settings change or the process ends.
      dispose: () => Promise.resolve(),
    };
    return { frame, free: () => [hdr, ldr, outputMaterial].forEach((resource) => resource.dispose()) };
  };

  return {
    renderer,
    frame(options) {
      const key = JSON.stringify(options);
      if (current?.key !== key) {
        current?.free();
        current = { key, ...build(options) };
      }
      return current.frame;
    },
    async dispose() {
      current?.free();
      renderer.dispose();
      await runtime.dispose();
    },
  };
}

/** Creates a GPU and one frame renderer that owns it, for a process that renders a single frame. */
export async function createFrameRenderer(options: IFrameRendererOptions): Promise<IFrameRenderer> {
  const gpu = await createGpu();
  return { ...gpu.frame(options), dispose: () => gpu.dispose() };
}
