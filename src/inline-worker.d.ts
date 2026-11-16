// Vite's inline worker imports, for type checking where vite/client's types aren't installed.
// The narrower pattern keeps it from merging with vite/client's declaration when both are present.
declare module '*.worker?worker&inline' {
  const WorkerConstructor: new () => Worker;
  export default WorkerConstructor;
}
