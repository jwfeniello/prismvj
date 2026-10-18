// Uploads decoded DXT/BC blocks as compressed textures and converts them, on
// the GPU, into an ordinary RGBA texture with the orientation and straight
// alpha the compositor expects from <video> uploads.

export const GPU_VIDEO_FRAGMENT = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 frag;
uniform sampler2D uPlane0;
uniform sampler2D uPlane1;
uniform sampler2D uPlane2;
uniform sampler2D uPlane3;
uniform vec2 uScale0;
uniform vec2 uScale1;
uniform vec2 uScale2;
uniform vec2 uScale3;
uniform int uLayout;
void main() {
  // Block data is stored top row first; textures start at the bottom row.
  vec2 q = vec2(uv.x, 1.0 - uv.y);
  vec4 c = texture(uPlane0, q * uScale0);
  if (uLayout == 6 || uLayout == 7) {
    // DXV high quality: Y (and alpha) in plane 0, half-size Co and Cg in plane 1.
    vec2 cocg = texture(uPlane1, q * uScale1).rg - 128.0 / 255.0;
    vec3 rgb = clamp(vec3(c.r + cocg.x - cocg.y, c.r + cocg.y, c.r - cocg.x - cocg.y), 0.0, 1.0);
    frag = vec4(rgb, uLayout == 7 ? c.g : 1.0);
  } else if (uLayout == 5) frag = vec4(c.a > 0.0 ? min(c.rgb / c.a, 1.0) : c.rgb, c.a);
  else if (uLayout == 2 || uLayout == 3) {
    // Scaled YCoCg in DXT5 (Hap Q): Co, Cg, scale and Y in R, G, B and A.
    float scale = floor(floor(c.b * 255.0 + 0.5) / 8.0) + 1.0;
    float co = (c.r - 128.0 / 255.0) / scale, cg = (c.g - 128.0 / 255.0) / scale;
    vec3 rgb = clamp(vec3(c.a + co - cg, c.a + cg, c.a - co - cg), 0.0, 1.0);
    frag = vec4(rgb, uLayout == 3 ? texture(uPlane1, q * uScale1).r : 1.0);
  } else if (uLayout == 4) frag = vec4(vec3(c.r), 1.0);
  else if (uLayout == 1) frag = vec4(clamp(c.rgb, 0.0, 1.0), 1.0);
  else frag = c;
}`;

export const GPU_VIDEO_UNIFORMS = ['uPlane0', 'uPlane1', 'uPlane2', 'uPlane3', 'uScale0', 'uScale1', 'uScale2', 'uScale3', 'uLayout'];
const LAYOUTS = { rgba: 0, rgb: 1, ycocg: 2, 'ycocg-alpha': 3, matte: 4, 'rgba-premultiplied': 5, 'ycocg-planar': 6, 'ycocg-planar-alpha': 7 };
// Planes expanded on the CPU when RGTC is unavailable.
const UNCOMPRESSED = { r8: ['R8', 'RED'], rg8: ['RG8', 'RG'] };

// The compressed formats this context can sample, by HAP/DXV texture name.
export function gpuVideoFormats(gl) {
  const s3tc = gl.getExtension('WEBGL_compressed_texture_s3tc'), rgtc = gl.getExtension('EXT_texture_compression_rgtc');
  const bptc = gl.getExtension('EXT_texture_compression_bptc');
  const formats = {};
  if (s3tc) Object.assign(formats, { dxt1: s3tc.COMPRESSED_RGB_S3TC_DXT1_EXT, dxt5: s3tc.COMPRESSED_RGBA_S3TC_DXT5_EXT, ycocg: s3tc.COMPRESSED_RGBA_S3TC_DXT5_EXT });
  if (rgtc) Object.assign(formats, { bc4: rgtc.COMPRESSED_RED_RGTC1_EXT, bc5: rgtc.COMPRESSED_RED_GREEN_RGTC2_EXT });
  if (bptc) Object.assign(formats, { bc7: bptc.COMPRESSED_RGBA_BPTC_UNORM_EXT, bc6u: bptc.COMPRESSED_RGB_BPTC_UNSIGNED_FLOAT_EXT, bc6s: bptc.COMPRESSED_RGB_BPTC_SIGNED_FLOAT_EXT });
  return formats;
}

export class GpuVideoSurface {
  constructor(gl, formats) {
    this.gl = gl;
    this.formats = formats;
    this.planes = [];
    this.framebuffer = null;
    this.width = this.height = 0;
  }

  // `width` x `height` is the stored size (whole blocks); `extent` the part
  // of it that covers the picture.
  _plane(index, { format, width, height, extent }) {
    const gl = this.gl, current = this.planes[index];
    if (current && current.format === format && current.width === width && current.height === height) {
      current.scale = [extent[0] / width, extent[1] / height];
      return current;
    }
    if (current) gl.deleteTexture(current.texture);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    // Full-size planes are sampled at texel centres; half-size chroma blends.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texStorage2D(gl.TEXTURE_2D, 1, UNCOMPRESSED[format] ? gl[UNCOMPRESSED[format][0]] : this.formats[format], width, height);
    return this.planes[index] = { texture, format, width, height, scale: [extent[0] / width, extent[1] / height] };
  }

  // Uploads one decoded frame. Throws when a texture format is unavailable.
  upload(frame) {
    const gl = this.gl;
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    frame.textures.forEach((source, index) => {
      const uncompressed = UNCOMPRESSED[source.format];
      if (!uncompressed && !this.formats[source.format]) throw new Error(`This graphics driver cannot display ${source.format.toUpperCase()} textures.`);
      const plane = this._plane(index, source);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, plane.texture);
      if (uncompressed) {
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, plane.width, plane.height, gl[uncompressed[1]], gl.UNSIGNED_BYTE, source.data);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      } else gl.compressedTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, plane.width, plane.height, this.formats[source.format], source.data);
    });
    this.layout = LAYOUTS[frame.layout] ?? 0;
    this.planeCount = frame.textures.length;
  }

  // Draws the uploaded planes into `target` (an RGBA texture of width x height).
  convert(program, target, width, height) {
    const gl = this.gl;
    if (!this.framebuffer || this.width !== width || this.height !== height || this.target !== target) {
      gl.bindTexture(gl.TEXTURE_2D, target);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      this.framebuffer ||= gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
      this.width = width; this.height = height; this.target = target;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.viewport(0, 0, width, height);
    gl.useProgram(program.program);
    const u = program.uniforms;
    for (let index = 0; index < 4; index++) {
      const plane = this.planes[Math.min(index, this.planeCount - 1)];
      gl.activeTexture(gl.TEXTURE0 + index);
      gl.bindTexture(gl.TEXTURE_2D, plane.texture);
      gl.uniform1i(u[`uPlane${index}`], index);
      gl.uniform2f(u[`uScale${index}`], plane.scale[0], plane.scale[1]);
    }
    gl.uniform1i(u.uLayout, this.layout);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
  }

  dispose(lost = false) {
    if (!lost) {
      for (const plane of this.planes) this.gl.deleteTexture(plane.texture);
      if (this.framebuffer) this.gl.deleteFramebuffer(this.framebuffer);
    }
    this.planes = [];
    this.framebuffer = null;
    this.target = null;
  }
}
