// Exercise tDB's oxmysql exports on the live server through the node:http
// transport: writes, reads, and a concurrent burst. Any unhandled rejection
// shows up in the console, which is the only detector that works here.
const ex = exports.tDB;
const out = [];
const run = async (name, fn) => {
  try {
    out.push({ name, ok: true, value: await fn() });
  } catch (e) {
    out.push({ name, ok: false, error: `${e.name}: ${e.message}` });
  }
};

await run("insert (DDL)", () =>
  ex.update(`CREATE TABLE IF NOT EXISTS tdb_probe (
     id INT NOT NULL AUTO_INCREMENT,
     tag VARCHAR(50),
     n INT DEFAULT 0,
     PRIMARY KEY (id)
   )`),
);
await run("insert row", () =>
  ex.insert("INSERT INTO tdb_probe (tag, n) VALUES (?, ?)", ["probe", 1]),
);
await run("single", () =>
  ex.single("SELECT * FROM tdb_probe WHERE tag = ?", ["probe"]),
);
await run("scalar count", () => ex.scalar("SELECT COUNT(*) FROM tdb_probe"));
await run("20 concurrent singles", async () => {
  const r = await Promise.allSettled(
    Array.from({ length: 20 }, () =>
      ex.single("SELECT * FROM tdb_probe WHERE tag = ?", ["probe"]),
    ),
  );
  return `${r.filter((x) => x.status === "fulfilled").length}/20 fulfilled`;
});
await run("20 concurrent updates", async () => {
  const r = await Promise.allSettled(
    Array.from({ length: 20 }, () =>
      ex.update("UPDATE tdb_probe SET n = n + 1 WHERE tag = ?", ["probe"]),
    ),
  );
  return `${r.filter((x) => x.status === "fulfilled").length}/20 fulfilled`;
});
await run("cleanup", () => ex.update("DROP TABLE tdb_probe"));

await ctx.sleep(2000);
return out;
