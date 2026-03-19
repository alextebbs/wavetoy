import {
  getColorMap,
  type ColorMapFn,
  type ColorMapName,
} from "@/lib/display-colors";
import { WaterfallRendererBase, type BaseTile } from "./waterfall-renderer-base";

interface GLTile extends BaseTile {
  texture: WebGLTexture | null;
}

const VERT_SRC = `#version 300 es
in vec2 a_pos;
uniform vec4 u_srcRect;
uniform vec4 u_dstRect;
uniform vec2 u_resolution;
out vec2 v_uv;

void main() {
  v_uv = u_srcRect.xy + a_pos * u_srcRect.zw;
  vec2 px = u_dstRect.xy + a_pos * u_dstRect.zw;
  vec2 ndc = (px / u_resolution) * 2.0 - 1.0;
  ndc.y = -ndc.y;
  gl_Position = vec4(ndc, 0.0, 1.0);
}
`;

const FRAG_SRC = `#version 300 es
precision mediump float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_data;
uniform sampler2D u_lut;

void main() {
  float t = texture(u_data, v_uv).r;
  fragColor = texture(u_lut, vec2(t, 0.5));
}
`;

export class WaterfallRendererGL extends WaterfallRendererBase<GLTile> {
  private gl!: WebGL2RenderingContext;
  private program!: WebGLProgram;
  private vao!: WebGLVertexArrayObject;
  private vbo!: WebGLBuffer;
  private lutTexture!: WebGLTexture;

  private uResolution!: WebGLUniformLocation;
  private uSrcRect!: WebGLUniformLocation;
  private uDstRect!: WebGLUniformLocation;
  private uData!: WebGLUniformLocation;
  private uLut!: WebGLUniformLocation;

  private normalizedBuf = new Uint8Array(1024);

  private contextLost = false;
  private contextHandlersAttached = false;
  private colorMapName: ColorMapName = "default";

  constructor(canvas: HTMLCanvasElement, options?: import("./waterfall-renderer-base").RendererOptions) {
    super(canvas, options);
    // Field initializers have now run — attach context loss handlers once
    if (!this.contextHandlersAttached) {
      this.contextHandlersAttached = true;
      this.canvas.addEventListener("webglcontextlost", (e) => {
        e.preventDefault();
        this.contextLost = true;
        this.stopRenderLoop();
      });
      this.canvas.addEventListener("webglcontextrestored", () => {
        this.contextLost = false;
        this.initContext();
        this.restoreTileTextures();
        this.startRenderLoop();
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Abstract method implementations
  // ---------------------------------------------------------------------------

  protected initContext(): void {
    const gl = this.canvas.getContext("webgl2", { alpha: false });
    if (!gl) throw new Error("WebGL2 not available");
    this.gl = gl;
    gl.clearColor(0, 0, 0, 1);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.compileShaders();
    this.createQuadVAO();
    this.rebuildLUT(getColorMap(this.colorMapName ?? "default"));
  }

  protected createTile(
    startRow: number,
    dataStartKHz: number,
    dataEndKHz: number,
  ): GLTile {
    let texture: WebGLTexture | null = null;
    if (!this.contextLost) {
      const gl = this.gl;
      texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.R8,
        this.numBins, this.tileHeight, 0,
        gl.RED, gl.UNSIGNED_BYTE, null,
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    }
    return {
      texture,
      rawBins: [],
      tuning: [],
      rowCount: 0,
      dataStartKHz,
      dataEndKHz,
      startRow,
    };
  }

  protected writeRow(tile: GLTile, bins: Uint8Array, rowIndex: number): void {
    if (this.contextLost || !tile.texture) return;
    this.normalizeRow(bins, this.normalizedBuf);
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tile.texture);
    gl.texSubImage2D(
      gl.TEXTURE_2D, 0,
      0, this.tileHeight - 1 - rowIndex,
      this.numBins, 1,
      gl.RED, gl.UNSIGNED_BYTE,
      this.normalizedBuf,
    );
  }

  protected drawFrame(): void {
    if (this.contextLost) return;
    const gl = this.gl;
    const { width, height } = this.canvas;
    if (width === 0 || height === 0) return;

    const viewSpan = this.viewEndKHz - this.viewStartKHz;
    if (viewSpan <= 0) {
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }

    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);

    gl.uniform2f(this.uResolution, width, height);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTexture);
    gl.uniform1i(this.uLut, 1);

    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(this.uData, 0);

    gl.bindVertexArray(this.vao);

    const effectiveOffset = this.scrollOffset;
    const visibleRowsTop = effectiveOffset;
    const visibleRowsBottom =
      effectiveOffset + Math.ceil(height / this.rowScale);

    for (const chunk of this.chunks) {
      for (const tile of chunk.tiles) {
        if (tile.rowCount === 0 || !tile.texture) continue;
        const tileTop = this.totalRows - tile.startRow - tile.rowCount;
        const tileBot = this.totalRows - tile.startRow - 1;
        if (tileTop > visibleRowsBottom || tileBot < visibleRowsTop) continue;
        this.drawTile(tile, width, height, viewSpan);
      }
    }

    for (const tile of this.liveTiles) {
      if (tile.rowCount === 0 || !tile.texture) continue;
      const tileTop = this.totalRows - tile.startRow - tile.rowCount;
      const tileBot = this.totalRows - tile.startRow - 1;
      if (tileTop > visibleRowsBottom || tileBot < visibleRowsTop) continue;
      this.drawTile(tile, width, height, viewSpan);
    }

    gl.bindVertexArray(null);
  }

  protected onLevelsChanged(): void {
    if (this.contextLost) return;
    const gl = this.gl;
    const reUpload = (tile: GLTile) => {
      if (!tile.texture) return;
      gl.bindTexture(gl.TEXTURE_2D, tile.texture);
      for (let i = 0; i < tile.rowCount; i++) {
        const bins = tile.rawBins[i];
        if (!bins) continue;
        this.normalizeRow(bins, this.normalizedBuf);
        gl.texSubImage2D(
          gl.TEXTURE_2D, 0,
          0, this.tileHeight - 1 - i,
          this.numBins, 1,
          gl.RED, gl.UNSIGNED_BYTE,
          this.normalizedBuf,
        );
      }
    };
    for (const tile of this.liveTiles) reUpload(tile);
    for (const chunk of this.chunks) {
      for (const tile of chunk.tiles) reUpload(tile);
    }
  }

  protected onResize(w: number, h: number): void {
    if (!this.contextLost) {
      this.gl.viewport(0, 0, w, h);
    }
  }

  protected destroyTile(tile: GLTile): void {
    if (tile.texture && !this.contextLost) {
      this.gl.deleteTexture(tile.texture);
    }
    tile.texture = null;
  }

  protected onDestroy(): void {
    if (this.contextLost) return;
    const gl = this.gl;
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.vao);
    gl.deleteBuffer(this.vbo);
    gl.deleteTexture(this.lutTexture);
  }

  // ---------------------------------------------------------------------------
  // GL-only public API
  // ---------------------------------------------------------------------------

  setColorMap(name: ColorMapName): void {
    this.colorMapName = name;
    if (!this.contextLost) {
      this.rebuildLUT(getColorMap(name));
      this.needsRepaint = true;
    }
  }

  // ---------------------------------------------------------------------------
  // GL internals
  // ---------------------------------------------------------------------------

  private compileShaders(): void {
    const gl = this.gl;

    const vs = gl.createShader(gl.VERTEX_SHADER)!;
    gl.shaderSource(vs, VERT_SRC);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(vs);
      gl.deleteShader(vs);
      throw new Error(`Vertex shader compilation failed: ${log}`);
    }

    const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
    gl.shaderSource(fs, FRAG_SRC);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(fs);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      throw new Error(`Fragment shader compilation failed: ${log}`);
    }

    this.program = gl.createProgram()!;
    gl.attachShader(this.program, vs);
    gl.attachShader(this.program, fs);
    gl.linkProgram(this.program);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(this.program);
      throw new Error(`Shader program link failed: ${log}`);
    }

    gl.deleteShader(vs);
    gl.deleteShader(fs);

    this.uResolution = gl.getUniformLocation(this.program, "u_resolution")!;
    this.uSrcRect = gl.getUniformLocation(this.program, "u_srcRect")!;
    this.uDstRect = gl.getUniformLocation(this.program, "u_dstRect")!;
    this.uData = gl.getUniformLocation(this.program, "u_data")!;
    this.uLut = gl.getUniformLocation(this.program, "u_lut")!;
  }

  private createQuadVAO(): void {
    const gl = this.gl;
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);

    this.vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
      gl.STATIC_DRAW,
    );

    const aPos = gl.getAttribLocation(this.program, "a_pos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    gl.bindVertexArray(null);
  }

  private rebuildLUT(fn: ColorMapFn): void {
    const gl = this.gl;
    const data = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
      const [r, g, b] = fn(i / 255);
      data[i * 4] = r;
      data[i * 4 + 1] = g;
      data[i * 4 + 2] = b;
      data[i * 4 + 3] = 255;
    }

    if (this.lutTexture) gl.deleteTexture(this.lutTexture);
    this.lutTexture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.lutTexture);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA,
      256, 1, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, data,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  private drawTile(
    tile: GLTile,
    visibleWidth: number,
    visibleHeight: number,
    viewSpan: number,
  ): void {
    const gl = this.gl;
    const layerSpan = tile.dataEndKHz - tile.dataStartKHz;
    if (layerSpan <= 0 || tile.rowCount <= 0) return;

    const overlapStart = Math.max(tile.dataStartKHz, this.viewStartKHz);
    const overlapEnd = Math.min(tile.dataEndKHz, this.viewEndKHz);
    if (overlapStart >= overlapEnd) return;

    const srcX =
      ((overlapStart - tile.dataStartKHz) / layerSpan) * this.numBins;
    const srcW =
      ((overlapEnd - overlapStart) / layerSpan) * this.numBins;
    const dstX =
      ((overlapStart - this.viewStartKHz) / viewSpan) * visibleWidth;
    const dstW = ((overlapEnd - overlapStart) / viewSpan) * visibleWidth;
    if (srcW < 0.5 || dstW < 0.5) return;

    const scaledOffset =
      (this.totalRows - tile.startRow - tile.rowCount - this.scrollOffset) *
      this.rowScale;
    if (scaledOffset >= visibleHeight) return;

    const srcY = this.tileHeight - tile.rowCount;
    const srcH = Math.min(
      tile.rowCount,
      Math.ceil((visibleHeight - scaledOffset) / this.rowScale),
    );
    if (srcH <= 0) return;
    const dstH = srcH * this.rowScale;

    gl.bindTexture(gl.TEXTURE_2D, tile.texture);
    const filter = srcW < dstW ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);

    gl.uniform4f(
      this.uSrcRect,
      srcX / this.numBins,
      srcY / this.tileHeight,
      srcW / this.numBins,
      srcH / this.tileHeight,
    );
    gl.uniform4f(this.uDstRect, dstX, scaledOffset, dstW, dstH);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private normalizeRow(bins: Uint8Array, out: Uint8Array): void {
    const range = this.maxLevel - this.minLevel;
    const invRange = range > 0 ? 1 / range : 0;
    for (let i = 0; i < bins.length; i++) {
      const dBm = bins[i] - 255;
      const t = (dBm - this.minLevel) * invRange;
      out[i] = Math.max(0, Math.min(255, (t * 255) | 0));
    }
  }

  private restoreTileTextures(): void {
    const gl = this.gl;
    const restore = (tile: GLTile) => {
      tile.texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tile.texture);
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.R8,
        this.numBins, this.tileHeight, 0,
        gl.RED, gl.UNSIGNED_BYTE, null,
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      for (let i = 0; i < tile.rowCount; i++) {
        const bins = tile.rawBins[i];
        if (!bins) continue;
        this.normalizeRow(bins, this.normalizedBuf);
        gl.texSubImage2D(
          gl.TEXTURE_2D, 0,
          0, this.tileHeight - 1 - i,
          this.numBins, 1,
          gl.RED, gl.UNSIGNED_BYTE,
          this.normalizedBuf,
        );
      }
    };

    for (const tile of this.liveTiles) restore(tile);
    for (const chunk of this.chunks) {
      for (const tile of chunk.tiles) restore(tile);
    }
  }
}
