import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/wreq-js.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node20",
  outExtension({ format }) {
    return format === "cjs" ? { js: ".cjs" } : { js: ".js" };
  },
  bundle: false
});
