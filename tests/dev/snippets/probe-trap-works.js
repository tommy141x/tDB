// Control: does process.on("unhandledRejection") actually fire in FiveM's
// runtime? Every earlier probe reported "rejections: []" using that hook. If
// FiveM reports rejections through V8's per-isolate callback and never emits
// the process event, those were false negatives and prove nothing.
const seen = [];
const handler = (reason) => seen.push(String((reason && reason.message) || reason));
process.on("unhandledRejection", handler);

// A deliberately unhandled rejection.
Promise.reject(new Error("tdb-trap-control-marker"));

await ctx.sleep(3000);
process.removeListener("unhandledRejection", handler);

return {
  node: process.version,
  caught: seen,
  trapFires: seen.includes("tdb-trap-control-marker"),
};
