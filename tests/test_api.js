// Calls the Vercel functions directly against the mock PULSE server (PULSE_BASE env).
const fns = { token: require("../api/token"), districts: require("../api/districts"), tehsils: require("../api/tehsils") };
function call(fn, query) {
  return new Promise((ok) => {
    const res = { h: {}, setHeader(k, v) { this.h[k] = v; }, status(c) { this.code = c; return this; }, send(b) { ok({ code: this.code, h: this.h, body: JSON.parse(b) }); } };
    fn({ query }, res);
  });
}
(async () => {
  console.log(await call(fns.token, {}));
  console.log(await call(fns.districts, { division_id: "9" }));
  console.log(await call(fns.tehsils, { district_id: "19" }));
  console.log(await call(fns.tehsils, { district_id: "x;rm" }));
})();
