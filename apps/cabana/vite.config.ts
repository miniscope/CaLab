import { defineCalabApp } from '@calab/vite-config';

export default defineCalabApp(import.meta.dirname);
// Running the solver in a worker? Add the WASM plugin to the main and worker builds:
// export default defineCalabApp(import.meta.dirname, { wasm: true });
