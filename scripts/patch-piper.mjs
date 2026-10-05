import fs from 'fs';
import path from 'path';

const file = path.join(process.cwd(), 'node_modules/@mintplex-labs/piper-tts-web/dist/piper-tts-web.js');
if (fs.existsSync(file)) {
  let content = fs.readFileSync(file, 'utf8');
  content = content.replace(
    'const ONNX_BASE = "https://cdnjs.cloudflare.com/ajax/libs/onnxruntime-web/1.18.0/";',
    'const ONNX_BASE = "/onnx/";'
  );
  content = content.replace(
    'ort.env.wasm.numThreads = navigator.hardwareConcurrency;',
    'ort.env.wasm.numThreads = (typeof self !== "undefined" && self.crossOriginIsolated) ? (navigator.hardwareConcurrency || 2) : 1;'
  );
  fs.writeFileSync(file, content, 'utf8');
  console.log('[LivreVox] piper-tts-web patched to use local /onnx/ files.');
}
