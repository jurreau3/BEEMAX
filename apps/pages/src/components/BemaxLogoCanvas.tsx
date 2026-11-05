import { useEffect, useRef } from "react";

interface BemaxLogoCanvasProps {
  width?: string | number;
  height?: string | number;
  invariantMarker?: string;
}

const vertexShaderSource = `
  attribute vec2 a_position;
  uniform float u_time;
  void main() {
    vec2 pos = a_position;
    pos.y += sin(pos.x * 10.0 + u_time) * 0.03;
    gl_Position = vec4(pos, 0.0, 1.0);
    gl_PointSize = 6.0;
  }
`;

const fragmentShaderSource = `
  precision mediump float;
  uniform float u_time;
  void main() {
    vec2 circCoord = gl_PointCoord - vec2(0.5);
    float dist = length(circCoord);
    if (dist > 0.5) discard;
    float alpha = smoothstep(0.5, 0.1, dist);
    vec3 color = vec3(1.0, 0.6 + sin(u_time) * 0.2, 0.1);
    gl_FragColor = vec4(color, alpha * 0.85);
  }
`;

function drawFallback(canvas: HTMLCanvasElement) {
  const context = canvas.getContext("2d");
  if (!context) return;

  const { width, height } = canvas;
  context.fillStyle = "#0a0a0f";
  context.fillRect(0, 0, width, height);
  context.save();
  context.translate(width / 2, height / 2);
  context.fillStyle = "#ffb400";
  for (let i = 0; i < 250; i += 1) {
    const progress = i / 250;
    const angle = progress * Math.PI * 4;
    const radius = Math.min(width, height) * 0.35 * progress;
    context.globalAlpha = 0.85;
    context.beginPath();
    context.arc(Math.cos(angle) * radius, Math.sin(angle) * radius, 2.5, 0, Math.PI * 2);
    context.fill();
  }
  context.restore();
}

export function BemaxLogoCanvas({
  width = "100%",
  height = "360px",
  invariantMarker = "I a gainst I",
}: BemaxLogoCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext("webgl");
    if (!gl) {
      drawFallback(canvas);
      return;
    }

    const createShader = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error(`Unable to compile BEMAX logo shader: ${gl.getShaderInfoLog(shader) ?? "unknown error"}`);
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    };

    const vertexShader = createShader(gl.VERTEX_SHADER, vertexShaderSource);
    const fragmentShader = createShader(gl.FRAGMENT_SHADER, fragmentShaderSource);
    if (!vertexShader || !fragmentShader) {
      if (vertexShader) gl.deleteShader(vertexShader);
      if (fragmentShader) gl.deleteShader(fragmentShader);
      drawFallback(canvas);
      return;
    }

    const program = gl.createProgram();
    if (!program) {
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      drawFallback(canvas);
      return;
    }

    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error(`Unable to link BEMAX logo shader program: ${gl.getProgramInfoLog(program) ?? "unknown error"}`);
      gl.deleteProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      drawFallback(canvas);
      return;
    }

    const particlesCount = 250;
    const positions = new Float32Array(particlesCount * 2);
    for (let i = 0; i < particlesCount; i += 1) {
      const angle = (i / particlesCount) * Math.PI * 4;
      const radius = 0.35 * (i / particlesCount);
      positions[i * 2] = Math.cos(angle) * radius;
      positions[i * 2 + 1] = Math.sin(angle) * radius;
    }

    const positionBuffer = gl.createBuffer();
    if (!positionBuffer) {
      gl.deleteProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      drawFallback(canvas);
      return;
    }

    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

    const positionLocation = gl.getAttribLocation(program, "a_position");
    const timeLocation = gl.getUniformLocation(program, "u_time");
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    let animationFrameId = 0;
    const startTime = performance.now();
    const resize = () => {
      const pixelRatio = window.devicePixelRatio || 1;
      const displayWidth = Math.max(1, Math.floor(canvas.clientWidth * pixelRatio));
      const displayHeight = Math.max(1, Math.floor(canvas.clientHeight * pixelRatio));
      if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
        canvas.width = displayWidth;
        canvas.height = displayHeight;
      }
      gl.viewport(0, 0, canvas.width, canvas.height);
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);
    resize();

    const render = (now: number) => {
      resize();
      gl.clearColor(0.04, 0.04, 0.06, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1f(timeLocation, (now - startTime) * 0.001);
      gl.drawArrays(gl.POINTS, 0, particlesCount);
      animationFrameId = requestAnimationFrame(render);
    };

    animationFrameId = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(animationFrameId);
      resizeObserver.disconnect();
      gl.deleteBuffer(positionBuffer);
      gl.deleteProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
    };
  }, []);

  return (
    <div
      style={{
        position: "relative",
        width,
        height,
        minHeight: 180,
        background: "#0a0a0f",
        borderRadius: 12,
        overflow: "hidden",
        border: "1px solid rgba(255, 180, 0, 0.2)",
      }}
    >
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`Animated BEMAX substrate signal visualization. ${invariantMarker}.`}
        style={{ width: "100%", height: "100%", display: "block" }}
      />
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          bottom: 16,
          left: 20,
          color: "rgba(255, 255, 255, 0.7)",
          fontFamily: "monospace",
          fontSize: 12,
          letterSpacing: 2,
          pointerEvents: "none",
        }}
      >
        BEMAX // SUBSTRATE ANIMATION [{invariantMarker}]
      </div>
    </div>
  );
}
