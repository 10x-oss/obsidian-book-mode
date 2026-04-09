import esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron"],
  format: "cjs",
  outfile: "main.js",
  platform: "browser",
  sourcemap: watch ? "inline" : false,
  target: "es2020",
  treeShaking: true,
});

if (watch) {
  await context.watch();
  console.log("[BookMode] watching for changes");
} else {
  await context.rebuild();
  await context.dispose();
  console.log("[BookMode] build complete");
}
