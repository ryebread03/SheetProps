/**
 * ============================================================================
 *  RefpropGS  -  REFPROP-style thermodynamic property functions for
 *                Google Sheets (Google Apps Script)
 * ============================================================================
 *
 *  Adds custom spreadsheet functions that mimic the NIST REFPROP Excel
 *  add-in call style:
 *
 *      =Density("R134a", "TP", "SI", 300, 500)
 *      =Enthalpy("Water", "PQ", "SI", 101.325, 1)
 *      =Temperature("Propane", "PH", "SI", 1000, 650)
 *
 *  Property engine: Peng-Robinson cubic equation of state (pure fluids)
 *  with ideal-gas heat-capacity polynomials, full departure functions,
 *  fugacity-based saturation solver, and PH/PS iterative flashes.
 *
 *  NOT affiliated with NIST. This does NOT call the licensed REFPROP
 *  library; accuracy is engineering-grade (see README).
 *
 *  Default reference state: h = 0, s = 0 for saturated liquid at the
 *  normal boiling point (REFPROP "NBP" default). Water uses saturated
 *  liquid at the triple point (steam-table convention).
 *
 *  Units systems:
 *    "SI"  : T [K],  P [kPa], D [kg/m3], H/U [kJ/kg], S/Cp/Cv [kJ/kg-K], W [m/s]
 *    "SIC" : same but T in [degC]
 *    "E"   : T [degF], P [psia], D [lbm/ft3], H/U [Btu/lb], S [Btu/lb-R], W [ft/s]
 * ============================================================================
 */

var RGAS = 8.314462618;   // J/mol-K
var PREF0 = 101325;       // Pa   (ideal-gas entropy reference pressure)
var TREF0 = 298.15;       // K    (ideal-gas enthalpy integration origin)
var SQ2 = Math.SQRT2;

/* ---------------------------------------------------------------------------
 * Fluid database
 *   M  : molar mass [kg/mol]
 *   Tc : critical temperature [K]
 *   Pc : critical pressure [Pa]
 *   w  : acentric factor [-]
 *   cp : ideal-gas cp = A + B*T + C*T^2 + D*T^3  [J/mol-K], T in K
 *   refT (optional): reference saturation temperature [K] (default = NBP)
 * ------------------------------------------------------------------------- */
var FLUID_DB = {
  WATER:     {name:'Water',           M:0.018015,  Tc:647.096, Pc:22.064e6, w:0.3443,  cp:[32.24, 1.923e-3, 1.055e-5, -3.595e-9], refT:273.16},
  NITROGEN:  {name:'Nitrogen',        M:0.0280134, Tc:126.192, Pc:3.3958e6, w:0.0372,  cp:[28.90,-1.571e-3, 8.081e-6, -2.873e-9]},
  OXYGEN:    {name:'Oxygen',          M:0.0319988, Tc:154.581, Pc:5.0430e6, w:0.0222,  cp:[25.48, 1.520e-2,-7.155e-6,  1.312e-9]},
  AIR:       {name:'Air (pseudo)',    M:0.0289647, Tc:132.53,  Pc:3.7860e6, w:0.0335,  cp:[28.11, 1.967e-3, 4.802e-6, -1.966e-9]},
  CO2:       {name:'Carbon dioxide',  M:0.0440098, Tc:304.128, Pc:7.3773e6, w:0.2239,  cp:[22.26, 5.981e-2,-3.501e-5,  7.469e-9]},
  CO:        {name:'Carbon monoxide', M:0.0280101, Tc:132.86,  Pc:3.4940e6, w:0.0497,  cp:[28.16, 1.675e-3, 5.372e-6, -2.222e-9]},
  ARGON:     {name:'Argon',           M:0.0399480, Tc:150.687, Pc:4.8630e6, w:-0.00219,cp:[20.786,0,0,0]},
  HELIUM:    {name:'Helium',          M:0.0040026, Tc:5.1953,  Pc:0.2276e6, w:-0.382,  cp:[20.786,0,0,0]},
  HYDROGEN:  {name:'Hydrogen',        M:0.0020159, Tc:33.145,  Pc:1.2964e6, w:-0.219,  cp:[29.11,-1.916e-3, 4.003e-6, -0.8704e-9]},
  METHANE:   {name:'Methane',         M:0.0160428, Tc:190.564, Pc:4.5992e6, w:0.01142, cp:[19.89, 5.024e-2, 1.269e-5, -1.101e-8]},
  ETHANE:    {name:'Ethane',          M:0.0300690, Tc:305.322, Pc:4.8722e6, w:0.0995,  cp:[6.900, 0.1727, -6.406e-5,  7.285e-9]},
  PROPANE:   {name:'Propane',         M:0.0440956, Tc:369.89,  Pc:4.2512e6, w:0.1521,  cp:[-4.04, 0.3048, -1.572e-4,  3.174e-8]},
  BUTANE:    {name:'n-Butane',        M:0.0581222, Tc:425.125, Pc:3.7960e6, w:0.201,   cp:[3.96,  0.3715, -1.834e-4,  3.500e-8]},
  ISOBUTANE: {name:'Isobutane',       M:0.0581222, Tc:407.81,  Pc:3.6290e6, w:0.184,   cp:[-7.913,0.4160, -2.301e-4,  4.991e-8]},
  ETHYLENE:  {name:'Ethylene',        M:0.0280538, Tc:282.35,  Pc:5.0418e6, w:0.0866,  cp:[3.95,  0.1564, -8.344e-5,  1.767e-8]},
  PROPYLENE: {name:'Propylene',       M:0.0420797, Tc:364.21,  Pc:4.5550e6, w:0.146,   cp:[3.15,  0.2383, -1.218e-4,  2.462e-8]},
  AMMONIA:   {name:'Ammonia',         M:0.0170305, Tc:405.40,  Pc:11.333e6, w:0.256,   cp:[27.568,2.563e-2, 9.9072e-6,-6.6909e-9]},
  METHANOL:  {name:'Methanol',        M:0.0320419, Tc:513.38,  Pc:8.2159e6, w:0.565,   cp:[19.0,  9.152e-2,-1.22e-5,  -8.039e-9]},
  ETHANOL:   {name:'Ethanol',         M:0.0460684, Tc:514.71,  Pc:6.2680e6, w:0.646,   cp:[19.9,  0.2096, -1.038e-4,  2.005e-8]},
  R134A:     {name:'R-134a',          M:0.1020320, Tc:374.21,  Pc:4.0593e6, w:0.3268,  cp:[25.0,  0.200, 0, 0]},
  R32:       {name:'R-32',            M:0.0520240, Tc:351.255, Pc:5.7820e6, w:0.2769,  cp:[19.9,  0.076, 0, 0]},
  R125:      {name:'R-125',           M:0.1200210, Tc:339.173, Pc:3.6177e6, w:0.3052,  cp:[35.0,  0.200, 0, 0]},
  R22:       {name:'R-22',            M:0.0864680, Tc:369.295, Pc:4.9899e6, w:0.22082, cp:[24.0,  0.110, 0, 0]},
  R1234YF:   {name:'R-1234yf',        M:0.1140416, Tc:367.85,  Pc:3.3822e6, w:0.276,   cp:[28.0,  0.250, 0, 0]},
  R410A:     {name:'R-410A (pseudo)', M:0.0725854, Tc:344.494, Pc:4.9012e6, w:0.296,   cp:[20.0,  0.135, 0, 0]},
  DIESEL:    {name:'Diesel (pseudo C12.3H22.2)', M:0.1701090, Tc:658.1, Pc:1.817e6, w:0.574, cp:[120.0, 0.51, 0, 0]},
  JP5:       {name:'JP-5 (pseudo C12H23)',       M:0.1673170, Tc:660.0, Pc:1.900e6, w:0.560, cp:[118.0, 0.50, 0, 0]}
};

var FLUID_ALIASES = {
  H2O:'WATER', STEAM:'WATER', R718:'WATER',
  N2:'NITROGEN', R728:'NITROGEN',
  O2:'OXYGEN', R732:'OXYGEN',
  CARBONDIOXIDE:'CO2', R744:'CO2',
  CARBONMONOXIDE:'CO',
  AR:'ARGON', R740:'ARGON',
  HE:'HELIUM', R704:'HELIUM',
  H2:'HYDROGEN', R702:'HYDROGEN',
  CH4:'METHANE', R50:'METHANE',
  C2H6:'ETHANE', R170:'ETHANE',
  C3H8:'PROPANE', R290:'PROPANE',
  NBUTANE:'BUTANE', C4H10:'BUTANE', R600:'BUTANE',
  IBUTANE:'ISOBUTANE', ISOBUTAN:'ISOBUTANE', R600A:'ISOBUTANE',
  C2H4:'ETHYLENE', R1150:'ETHYLENE',
  C3H6:'PROPYLENE', PROPENE:'PROPYLENE', R1270:'PROPYLENE',
  NH3:'AMMONIA', R717:'AMMONIA',
  MEOH:'METHANOL', CH3OH:'METHANOL',
  ETOH:'ETHANOL', C2H5OH:'ETHANOL',
  R134:'R134A',
  JETA:'JP5', JP8:'JP5', KEROSENE:'JP5', JETFUEL:'JP5',
  DIESELFUEL:'DIESEL'
};

/* ========================================================================
 *  Low-level utilities
 * ====================================================================== */

function _getFluid(fluid) {
  if (fluid === null || fluid === undefined || fluid === '') {
    throw new Error('Fluid name is required');
  }
  var key = String(fluid).toUpperCase().replace(/[\s\-_\.]/g, '');
  if (FLUID_ALIASES[key]) key = FLUID_ALIASES[key];
  var f = FLUID_DB[key];
  if (!f) throw new Error('Unknown fluid "' + fluid + '". Use =FluidList() to see supported fluids.');
  return f;
}

function _normUnits(u) {
  if (u === null || u === undefined || u === '') return 'SI';
  var s = String(u).toUpperCase().replace(/[\s\-_]/g, '');
  if (s === 'SI' || s === 'K') return 'SI';
  if (s === 'SIC' || s === 'C' || s === 'SIWITHC') return 'SIC';
  if (s === 'E' || s === 'ENGLISH' || s === 'IP' || s === 'F') return 'E';
  throw new Error('Unknown units "' + u + '". Use "SI" (K, kPa), "SIC" (degC, kPa) or "E" (degF, psia).');
}

/* Allows the Units argument to be omitted:  Density("N2","TP",300,101.325) */
function _shiftArgs(units, p1, p2) {
  if (typeof units === 'number') return ['SI', units, p1];
  return [_normUnits(units), p1, p2];
}

function _num(x, label) {
  if (typeof x !== 'number' || !isFinite(x)) {
    throw new Error('Input "' + label + '" must be a number');
  }
  return x;
}

/* --- input conversions -> internal SI (K, Pa, J/mol, J/mol-K, kg/m3) ----- */
function _Tin(t, u)  { return u === 'SI' ? t : (u === 'SIC' ? t + 273.15 : (t + 459.67) / 1.8); }
function _Pin(p, u)  { return u === 'E' ? p * 6894.757293 : p * 1000; }
function _Hin(h, u, f) { var kJkg = (u === 'E') ? h * 2.326 : h; return kJkg * 1000 * f.M; }
function _Sin(s, u, f) { var kJkgK = (u === 'E') ? s * 4.1868 : s; return kJkgK * 1000 * f.M; }
function _Din(d, u)  { return u === 'E' ? d * 16.01846337 : d; }

/* --- output conversions from internal SI-mass values --------------------- */
function _out(val, key, u) {
  switch (key) {
    case 'T': return u === 'SI' ? val : (u === 'SIC' ? val - 273.15 : val * 1.8 - 459.67);
    case 'P': return u === 'E' ? val * 0.1450377377 : val;              // kPa -> psia
    case 'D': return u === 'E' ? val * 0.06242796 : val;                // kg/m3 -> lbm/ft3
    case 'V': return u === 'E' ? val / 0.06242796 : val;                // m3/kg -> ft3/lbm
    case 'H': case 'U': case 'HFG':
              return u === 'E' ? val / 2.326 : val;                     // kJ/kg -> Btu/lb
    case 'S': case 'CP': case 'CV':
              return u === 'E' ? val / 4.1868 : val;                    // kJ/kg-K -> Btu/lb-R
    case 'W': return u === 'E' ? val * 3.280839895 : val;               // m/s -> ft/s
    default:  return val;                                               // Q, Z dimensionless
  }
}

/* ========================================================================
 *  Peng-Robinson EOS core
 * ====================================================================== */

function _prCoef(f, T) {
  var a = 0.45724 * RGAS * RGAS * f.Tc * f.Tc / f.Pc;
  var b = 0.07780 * RGAS * f.Tc / f.Pc;
  var k = 0.37464 + 1.54226 * f.w - 0.26992 * f.w * f.w;
  var sqA = 1 + k * (1 - Math.sqrt(T / f.Tc));      // sqrt(alpha)
  var aa = a * sqA * sqA;                            // a*alpha
  var dadT = -a * k * sqA / Math.sqrt(T * f.Tc);     // d(a*alpha)/dT
  var d2adT2 = a * (k * k / (2 * T * f.Tc) +
                    k * sqA / (2 * Math.pow(T, 1.5) * Math.sqrt(f.Tc)));
  return { a: a, b: b, aa: aa, dadT: dadT, d2adT2: d2adT2 };
}

/* Real roots of z^3 + c2 z^2 + c1 z + c0 = 0 */
function _solveCubic(c2, c1, c0) {
  var p = c1 - c2 * c2 / 3;
  var q = 2 * c2 * c2 * c2 / 27 - c2 * c1 / 3 + c0;
  var disc = q * q / 4 + p * p * p / 27;
  var roots = [];
  if (disc > 0) {
    var sq = Math.sqrt(disc);
    roots.push(Math.cbrt(-q / 2 + sq) + Math.cbrt(-q / 2 - sq) - c2 / 3);
  } else {
    var r = Math.sqrt(-p * p * p / 27);
    var cosArg = Math.max(-1, Math.min(1, -q / (2 * r)));
    var th = Math.acos(cosArg);
    var m = 2 * Math.cbrt(r);
    for (var kk = 0; kk < 3; kk++) {
      roots.push(m * Math.cos((th + 2 * Math.PI * kk) / 3) - c2 / 3);
    }
  }
  return roots;
}

/* Compressibility-factor roots at (T, P); returns sorted valid roots */
function _zRoots(f, T, P) {
  var c = _prCoef(f, T);
  var A = c.aa * P / (RGAS * RGAS * T * T);
  var B = c.b * P / (RGAS * T);
  var rts = _solveCubic(-(1 - B), A - 3 * B * B - 2 * B, -(A * B - B * B - B * B * B));
  var Z = [];
  for (var i = 0; i < rts.length; i++) {
    if (isFinite(rts[i]) && rts[i] > B * (1 + 1e-10)) Z.push(rts[i]);
  }
  Z.sort(function (x, y) { return x - y; });
  return { Z: Z, A: A, B: B, c: c };
}

function _lnPhi(Z, A, B) {
  return (Z - 1) - Math.log(Z - B) -
         A / (2 * SQ2 * B) * Math.log((Z + (1 + SQ2) * B) / (Z + (1 - SQ2) * B));
}

/* Full single-phase state from (T, molar volume). All molar SI units. */
function _rawTv(f, T, v) {
  var c = _prCoef(f, T);
  var den = v * v + 2 * c.b * v - c.b * c.b;
  var P = RGAS * T / (v - c.b) - c.aa / den;
  var Z = P * v / (RGAS * T);
  var L = Math.log((v + (1 + SQ2) * c.b) / (v + (1 - SQ2) * c.b));
  var K = 1 / (2 * SQ2 * c.b);

  var cp0 = _cp0(f, T);
  var h0 = _h0(f, T);
  var s0 = _s0(f, T, P);

  var hdep = RGAS * T * (Z - 1) + (T * c.dadT - c.aa) * K * L;
  var sdep = RGAS * Math.log(P * (v - c.b) / (RGAS * T)) + c.dadT * K * L;

  var cv = (cp0 - RGAS) + T * c.d2adT2 * K * L;
  var dPdT = RGAS / (v - c.b) - c.dadT / den;
  var dPdv = -RGAS * T / ((v - c.b) * (v - c.b)) + c.aa * (2 * v + 2 * c.b) / (den * den);
  var cp = cv - T * dPdT * dPdT / dPdv;
  var w2 = -v * v * (cp / cv) * dPdv / f.M;

  var h = h0 + hdep;
  return {
    T: T, P: P, v: v, Z: Z,
    h: h, s: s0 + sdep, u: h - P * v,
    cp: cp, cv: cv,
    w: w2 > 0 ? Math.sqrt(w2) : 0
  };
}

function _cp0(f, T) {
  var c = f.cp;
  return c[0] + c[1] * T + c[2] * T * T + c[3] * T * T * T;
}
function _h0(f, T) {
  var c = f.cp, t = TREF0;
  return c[0] * (T - t) + c[1] / 2 * (T * T - t * t) +
         c[2] / 3 * (T * T * T - t * t * t) + c[3] / 4 * (T * T * T * T - t * t * t * t);
}
function _s0(f, T, P) {
  var c = f.cp, t = TREF0;
  return c[0] * Math.log(T / t) + c[1] * (T - t) + c[2] / 2 * (T * T - t * t) +
         c[3] / 3 * (T * T * T - t * t * t) - RGAS * Math.log(P / PREF0);
}

/* ========================================================================
 *  Saturation
 * ====================================================================== */

/* Vapor pressure [Pa] at T via equality of fugacities */
function _psat(f, T) {
  if (T >= f.Tc) throw new Error('T (' + T.toFixed(2) + ' K) is at/above the critical temperature of ' + f.name + ' (' + f.Tc.toFixed(2) + ' K); no saturation state exists.');
  if (T <= 0) throw new Error('Temperature must be positive (in absolute units).');
  var P = f.Pc * Math.exp(5.372697 * (1 + f.w) * (1 - f.Tc / T));   // Wilson guess
  P = Math.min(Math.max(P, 1e-8), 0.9999 * f.Pc);
  for (var it = 0; it < 300; it++) {
    var zr = _zRoots(f, T, P);
    if (zr.Z.length >= 2) {
      var Zl = zr.Z[0], Zv = zr.Z[zr.Z.length - 1];
      var dphi = _lnPhi(Zl, zr.A, zr.B) - _lnPhi(Zv, zr.A, zr.B);
      P = P * Math.exp(dphi);
      if (Math.abs(dphi) < 1e-10) return P;
    } else {
      // single root: decide direction from its character
      var Z1 = zr.Z[0];
      var v1 = Z1 * RGAS * T / P;
      if (v1 > 3 * zr.c.b) P = P * 1.15;   // vapor-like only -> raise P
      else P = P * 0.85;                    // liquid-like only -> lower P
      P = Math.min(Math.max(P, 1e-8), 0.99999 * f.Pc);
    }
  }
  return P;   // near-critical: return best estimate
}

/* Saturation temperature [K] at P [Pa] */
function _tsat(f, P) {
  if (P >= f.Pc) throw new Error('P is at/above the critical pressure of ' + f.name + ' (' + (f.Pc / 1000).toFixed(1) + ' kPa); no saturation state exists.');
  if (P <= 0) throw new Error('Pressure must be positive.');
  var denom = 1 - Math.log(P / f.Pc) / (5.372697 * (1 + f.w));
  var T = f.Tc / Math.max(denom, 1.0001);
  T = Math.min(Math.max(T, 0.2 * f.Tc), 0.99995 * f.Tc);
  var g = function (t) { return Math.log(_psat(f, t) / P); };
  var T2 = Math.min(T * 1.02, 0.99995 * f.Tc);
  var g1 = g(T), g2 = g(T2);
  for (var it = 0; it < 80; it++) {
    if (Math.abs(g2 - g1) < 1e-14) break;
    var Tn = T2 - g2 * (T2 - T) / (g2 - g1);
    Tn = Math.min(Math.max(Tn, 0.15 * f.Tc), 0.99999 * f.Tc);
    T = T2; g1 = g2;
    T2 = Tn; g2 = g(T2);
    if (Math.abs(T2 - T) < 1e-9 * T2) break;
  }
  return T2;
}

/* Saturated liquid & vapor states at T. Returns {P, L, V} (raw molar). */
function _satTv(f, T) {
  var P = _psat(f, T);
  var zr = _zRoots(f, T, P);
  if (zr.Z.length < 2) {
    throw new Error('Saturation state too close to the critical point of ' + f.name + ' to resolve.');
  }
  var vL = zr.Z[0] * RGAS * T / P;
  var vV = zr.Z[zr.Z.length - 1] * RGAS * T / P;
  return { P: P, L: _rawTv(f, T, vL), V: _rawTv(f, T, vV) };
}

/* ========================================================================
 *  Reference-state offsets (h = s = 0, saturated liquid @ NBP;
 *  water: saturated liquid @ triple point)
 * ====================================================================== */
function _refOff(f) {
  if (f._off) return f._off;
  var Tref = f.refT || _tsat(f, 101325);
  var sat = _satTv(f, Tref);
  f._off = { h: sat.L.h, s: sat.L.s };
  return f._off;
}

/* ========================================================================
 *  Flash routines
 *  All internal values SI-molar: T [K], P [Pa], h [J/mol], s [J/mol-K]
 * ====================================================================== */

function _stateTP(f, T, P) {
  if (T <= 0) throw new Error('Temperature must be positive (absolute).');
  if (P <= 0) throw new Error('Pressure must be positive.');
  var zr = _zRoots(f, T, P);
  if (zr.Z.length === 0) throw new Error('No physical root found at this T, P for ' + f.name + '.');
  var Z;
  if (zr.Z.length === 1) {
    Z = zr.Z[0];
  } else if (T >= f.Tc) {
    // pick root of minimum Gibbs energy
    var Za = zr.Z[0], Zb = zr.Z[zr.Z.length - 1];
    Z = (_lnPhi(Za, zr.A, zr.B) < _lnPhi(Zb, zr.A, zr.B)) ? Za : Zb;
  } else {
    var Ps = _psat(f, T);
    Z = (P >= Ps) ? zr.Z[0] : zr.Z[zr.Z.length - 1];
  }
  return _rawTv(f, T, Z * RGAS * T / P);
}

function _flash(f, code, a, b) {
  var sat, q, Ts;
  switch (code) {
    case 'TP':
      return { ph: 1, st: _stateTP(f, a, b) };
    case 'TQ':
      q = b;
      if (q < -1e-9 || q > 1 + 1e-9) throw new Error('Quality must be between 0 and 1.');
      sat = _satTv(f, a);
      return { ph: 2, T: a, P: sat.P, q: Math.min(Math.max(q, 0), 1), L: sat.L, V: sat.V };
    case 'PQ':
      q = b;
      if (q < -1e-9 || q > 1 + 1e-9) throw new Error('Quality must be between 0 and 1.');
      Ts = _tsat(f, a);
      sat = _satTv(f, Ts);
      return { ph: 2, T: Ts, P: sat.P, q: Math.min(Math.max(q, 0), 1), L: sat.L, V: sat.V };
    case 'TD': {
      var v = f.M / b;              // b = density kg/m3 -> molar volume
      var cb = _prCoef(f, a).b;
      if (v <= cb) throw new Error('Density too high (molar volume below the co-volume limit).');
      return { ph: 1, st: _rawTv(f, a, v) };
    }
    case 'PH': return _flashPX(f, a, b, 'h');
    case 'PS': return _flashPX(f, a, b, 's');
    case 'HS': return _flashHS(f, a, b);
    default:
      throw new Error('Unsupported input pair "' + code + '". Supported: TP, TQ, PQ, PH, PS, HS, TD.');
  }
}

/* H + S flash: outer bisection on ln(P), inner PH flash.
 * At constant h, (ds/dP) = -v/T < 0, so entropy is monotonically
 * decreasing in P and bisection is safe (single-phase and two-phase). */
function _flashHS(f, H, S) {
  var lnLo = Math.log(10);       // 10 Pa
  var lnHi = Math.log(5e8);      // 500 MPa
  function sAtLnP(lnP) {
    var fl = _flash(f, 'PH', Math.exp(lnP), H);
    if (fl.ph === 2) return (1 - fl.q) * fl.L.s + fl.q * fl.V.s;
    return fl.st.s;
  }
  var gLo = null, gHi = null;
  // pull bounds inward if the PH flash cannot converge at the extremes
  for (var i = 0; i < 25 && gLo === null; i++) {
    try { gLo = sAtLnP(lnLo) - S; } catch (e) { lnLo += 0.7; }
  }
  for (var j = 0; j < 25 && gHi === null; j++) {
    try { gHi = sAtLnP(lnHi) - S; } catch (e) { lnHi -= 0.7; }
  }
  if (gLo === null || gHi === null || gLo * gHi > 0) {
    throw new Error('No solution found for the given H and S with ' + f.name +
      ' (state outside computable range).');
  }
  var lnM = lnLo;
  for (var it = 0; it < 100; it++) {
    lnM = 0.5 * (lnLo + lnHi);
    var gM = sAtLnP(lnM) - S;
    if (gM === 0 || (lnHi - lnLo) < 1e-11) break;
    if (gLo * gM < 0) { lnHi = lnM; gHi = gM; } else { lnLo = lnM; gLo = gM; }
  }
  return _flash(f, 'PH', Math.exp(lnM), H);
}

/* P + (h or s) flash */
function _flashPX(f, P, X, key) {
  var TLO = Math.max(0.2 * f.Tc, 2);
  var THI = 2500;
  if (P < f.Pc) {
    var Ts = _tsat(f, P);
    var sat = _satTv(f, Ts);
    var xL = sat.L[key], xV = sat.V[key];
    if (X >= xL && X <= xV) {
      var q = (X - xL) / (xV - xL);
      return { ph: 2, T: Ts, P: P, q: q, L: sat.L, V: sat.V };
    }
    if (X < xL) return _bisectT(f, P, X, key, TLO, Ts - 1e-6, (X - xL) / (xV - xL));
    return _bisectT(f, P, X, key, Ts + 1e-6, THI, (X - xL) / (xV - xL));
  }
  return _bisectT(f, P, X, key, TLO, THI, null);
}

function _bisectT(f, P, X, key, Tlo, Thi, qHint) {
  var g = function (T) { return _stateTP(f, T, P)[key] - X; };
  var glo, ghi;
  try { glo = g(Tlo); } catch (e) { Tlo = Tlo * 1.5; glo = g(Tlo); }
  ghi = g(Thi);
  if (glo * ghi > 0) {
    throw new Error('No solution found for the given P and ' + key.toUpperCase() +
      ' with ' + f.name + ' (target outside computable range).');
  }
  var Tm = Tlo, gm;
  for (var it = 0; it < 100; it++) {
    Tm = 0.5 * (Tlo + Thi);
    gm = g(Tm);
    if (gm === 0 || (Thi - Tlo) < 1e-9 * Tm) break;
    if (glo * gm < 0) { Thi = Tm; ghi = gm; } else { Tlo = Tm; glo = gm; }
  }
  var fl = { ph: 1, st: _stateTP(f, Tm, P) };
  if (qHint !== null && qHint !== undefined) fl.qHint = qHint;
  return fl;
}

/* ========================================================================
 *  Property extraction (returns SI mass-based values)
 * ====================================================================== */
function _getProp(f, fl, key) {
  var off = _refOff(f);
  var M = f.M;
  function mass(st, k) {
    switch (k) {
      case 'D': return M / st.v;
      case 'V': return st.v / M;
      case 'H': return (st.h - off.h) / M / 1000;
      case 'S': return (st.s - off.s) / M / 1000;
      case 'U': return (st.u - off.h) / M / 1000;
      case 'CP': return st.cp / M / 1000;
      case 'CV': return st.cv / M / 1000;
      case 'W': return st.w;
      case 'Z': return st.Z;
    }
  }
  if (fl.ph === 1) {
    var st = fl.st;
    switch (key) {
      case 'T': return st.T;
      case 'P': return st.P / 1000;
      case 'Q':
        if (fl.qHint !== undefined) return fl.qHint;
        if (st.T >= f.Tc || st.P >= f.Pc) return 999;      // supercritical
        return (st.P >= _psat(f, st.T)) ? -999 : 999;      // subcooled / superheated
      default: return mass(st, key);
    }
  }
  // two-phase
  switch (key) {
    case 'T': return fl.T;
    case 'P': return fl.P / 1000;
    case 'Q': return fl.q;
    case 'CP': case 'CV': case 'W': case 'Z':
      throw new Error(key + ' is undefined inside the two-phase region.');
    case 'D': {
      var vmix = (1 - fl.q) * fl.L.v + fl.q * fl.V.v;
      return M / vmix;
    }
    case 'V': {
      var vm = (1 - fl.q) * fl.L.v + fl.q * fl.V.v;
      return vm / M;
    }
    case 'H': return ((1 - fl.q) * fl.L.h + fl.q * fl.V.h - off.h) / M / 1000;
    case 'S': return ((1 - fl.q) * fl.L.s + fl.q * fl.V.s - off.s) / M / 1000;
    case 'U': return ((1 - fl.q) * fl.L.u + fl.q * fl.V.u - off.h) / M / 1000;
  }
}

/* ========================================================================
 *  Shared front-end for the spreadsheet functions
 * ====================================================================== */
function _prop(fluid, inpCode, units, p1, p2, key) {
  var f = _getFluid(fluid);
  var sh = _shiftArgs(units, p1, p2);
  var u = sh[0]; p1 = _num(sh[1], 'Prop1'); p2 = _num(sh[2], 'Prop2');

  if (inpCode === null || inpCode === undefined) throw new Error('Input code (e.g. "TP") is required');
  var code = String(inpCode).toUpperCase().replace(/[^A-Z]/g, '');
  if (code.length !== 2) throw new Error('Input code must be two letters, e.g. "TP", "PH", "TQ".');

  // Normalize letter order and convert inputs to internal units
  var vals = {};
  var c1 = code.charAt(0), c2 = code.charAt(1);
  var raw = {}; raw[c1] = p1; raw[c2] = p2;
  if (c1 === c2) throw new Error('Input code letters must differ.');
  for (var L in raw) {
    switch (L) {
      case 'T': vals.T = _Tin(raw[L], u); break;
      case 'P': vals.P = _Pin(raw[L], u); break;
      case 'H': vals.H = _Hin(raw[L], u, f) + _refOff(f).h; break;
      case 'S': vals.S = _Sin(raw[L], u, f) + _refOff(f).s; break;
      case 'Q': vals.Q = raw[L]; break;
      case 'D': vals.D = _Din(raw[L], u); break;
      default: throw new Error('Unknown property letter "' + L + '" in input code.');
    }
  }
  var fl;
  if ('T' in vals && 'P' in vals) fl = _flash(f, 'TP', vals.T, vals.P);
  else if ('T' in vals && 'Q' in vals) fl = _flash(f, 'TQ', vals.T, vals.Q);
  else if ('P' in vals && 'Q' in vals) fl = _flash(f, 'PQ', vals.P, vals.Q);
  else if ('P' in vals && 'H' in vals) fl = _flash(f, 'PH', vals.P, vals.H);
  else if ('P' in vals && 'S' in vals) fl = _flash(f, 'PS', vals.P, vals.S);
  else if ('T' in vals && 'D' in vals) fl = _flash(f, 'TD', vals.T, vals.D);
  else if ('H' in vals && 'S' in vals) fl = _flash(f, 'HS', vals.H, vals.S);
  else throw new Error('Unsupported input pair "' + code + '". Supported: TP, TQ, PQ, PH, PS, HS, TD.');

  return _out(_getProp(f, fl, key), key, u);
}

/* ========================================================================
 *  CUSTOM SPREADSHEET FUNCTIONS
 * ====================================================================== */

/**
 * Density of a fluid. Example: =Density("R134a","TP","SI",300,500)
 * @param {string} fluid Fluid name (e.g. "Water", "R134a", "CO2")
 * @param {string} inpCode Input pair: "TP","TQ","PQ","PH","PS","HS","TD"
 * @param {string} units "SI" (K,kPa), "SIC" (degC,kPa) or "E" (degF,psia). Optional, default "SI".
 * @param {number} prop1 First input property
 * @param {number} prop2 Second input property
 * @return {number} Density [kg/m3] ("SI"/"SIC") or [lbm/ft3] ("E")
 * @customfunction
 */
function Density(fluid, inpCode, units, prop1, prop2) { return _prop(fluid, inpCode, units, prop1, prop2, 'D'); }

/**
 * Specific volume. Example: =Volume("Water","TP","SI",400,101.325)
 * @param {string} fluid Fluid name
 * @param {string} inpCode Input pair: "TP","TQ","PQ","PH","PS","HS","TD"
 * @param {string} units "SI", "SIC" or "E" (optional, default "SI")
 * @param {number} prop1 First input property
 * @param {number} prop2 Second input property
 * @return {number} Specific volume [m3/kg] or [ft3/lbm]
 * @customfunction
 */
function Volume(fluid, inpCode, units, prop1, prop2) { return _prop(fluid, inpCode, units, prop1, prop2, 'V'); }

/**
 * Specific enthalpy. Example: =Enthalpy("Water","PQ","SI",101.325,1)
 * @param {string} fluid Fluid name
 * @param {string} inpCode Input pair: "TP","TQ","PQ","PH","PS","HS","TD"
 * @param {string} units "SI", "SIC" or "E" (optional, default "SI")
 * @param {number} prop1 First input property
 * @param {number} prop2 Second input property
 * @return {number} Enthalpy [kJ/kg] or [Btu/lb]
 * @customfunction
 */
function Enthalpy(fluid, inpCode, units, prop1, prop2) { return _prop(fluid, inpCode, units, prop1, prop2, 'H'); }

/**
 * Specific entropy. Example: =Entropy("N2","TP","SI",300,101.325)
 * @param {string} fluid Fluid name
 * @param {string} inpCode Input pair: "TP","TQ","PQ","PH","PS","HS","TD"
 * @param {string} units "SI", "SIC" or "E" (optional, default "SI")
 * @param {number} prop1 First input property
 * @param {number} prop2 Second input property
 * @return {number} Entropy [kJ/kg-K] or [Btu/lb-R]
 * @customfunction
 */
function Entropy(fluid, inpCode, units, prop1, prop2) { return _prop(fluid, inpCode, units, prop1, prop2, 'S'); }

/**
 * Specific internal energy.
 * @param {string} fluid Fluid name
 * @param {string} inpCode Input pair: "TP","TQ","PQ","PH","PS","HS","TD"
 * @param {string} units "SI", "SIC" or "E" (optional, default "SI")
 * @param {number} prop1 First input property
 * @param {number} prop2 Second input property
 * @return {number} Internal energy [kJ/kg] or [Btu/lb]
 * @customfunction
 */
function InternalEnergy(fluid, inpCode, units, prop1, prop2) { return _prop(fluid, inpCode, units, prop1, prop2, 'U'); }

/**
 * Isobaric (constant-pressure) heat capacity. Single-phase states only.
 * @param {string} fluid Fluid name
 * @param {string} inpCode Input pair: "TP","PH","PS","HS","TD"
 * @param {string} units "SI", "SIC" or "E" (optional, default "SI")
 * @param {number} prop1 First input property
 * @param {number} prop2 Second input property
 * @return {number} Cp [kJ/kg-K] or [Btu/lb-R]
 * @customfunction
 */
function Cp(fluid, inpCode, units, prop1, prop2) { return _prop(fluid, inpCode, units, prop1, prop2, 'CP'); }

/**
 * Isochoric (constant-volume) heat capacity. Single-phase states only.
 * @param {string} fluid Fluid name
 * @param {string} inpCode Input pair: "TP","PH","PS","HS","TD"
 * @param {string} units "SI", "SIC" or "E" (optional, default "SI")
 * @param {number} prop1 First input property
 * @param {number} prop2 Second input property
 * @return {number} Cv [kJ/kg-K] or [Btu/lb-R]
 * @customfunction
 */
function Cv(fluid, inpCode, units, prop1, prop2) { return _prop(fluid, inpCode, units, prop1, prop2, 'CV'); }

/**
 * Speed of sound. Single-phase states only.
 * @param {string} fluid Fluid name
 * @param {string} inpCode Input pair: "TP","PH","PS","HS","TD"
 * @param {string} units "SI", "SIC" or "E" (optional, default "SI")
 * @param {number} prop1 First input property
 * @param {number} prop2 Second input property
 * @return {number} Speed of sound [m/s] or [ft/s]
 * @customfunction
 */
function SoundSpeed(fluid, inpCode, units, prop1, prop2) { return _prop(fluid, inpCode, units, prop1, prop2, 'W'); }

/**
 * Compressibility factor Z = Pv/RT. Single-phase states only.
 * @param {string} fluid Fluid name
 * @param {string} inpCode Input pair: "TP","PH","PS","HS","TD"
 * @param {string} units "SI", "SIC" or "E" (optional, default "SI")
 * @param {number} prop1 First input property
 * @param {number} prop2 Second input property
 * @return {number} Z [-]
 * @customfunction
 */
function Compressibility(fluid, inpCode, units, prop1, prop2) { return _prop(fluid, inpCode, units, prop1, prop2, 'Z'); }

/**
 * Temperature from an input pair. Example: =Temperature("Propane","PH","SI",1000,650)
 * @param {string} fluid Fluid name
 * @param {string} inpCode Input pair: "PQ","PH","PS","HS" (also accepts "TP","TQ","TD")
 * @param {string} units "SI", "SIC" or "E" (optional, default "SI")
 * @param {number} prop1 First input property
 * @param {number} prop2 Second input property
 * @return {number} Temperature [K], [degC] or [degF]
 * @customfunction
 */
function Temperature(fluid, inpCode, units, prop1, prop2) { return _prop(fluid, inpCode, units, prop1, prop2, 'T'); }

/**
 * Pressure from an input pair. Example: =Pressure("CO2","TQ","SI",273.15,0)
 * @param {string} fluid Fluid name
 * @param {string} inpCode Input pair: "TQ","TD","HS" (also accepts "TP","PQ","PH","PS")
 * @param {string} units "SI", "SIC" or "E" (optional, default "SI")
 * @param {number} prop1 First input property
 * @param {number} prop2 Second input property
 * @return {number} Pressure [kPa] or [psia]
 * @customfunction
 */
function Pressure(fluid, inpCode, units, prop1, prop2) { return _prop(fluid, inpCode, units, prop1, prop2, 'P'); }

/**
 * Vapor quality (mass fraction of vapor). For single-phase PH/PS states the
 * extrapolated value is returned (<0 subcooled, >1 superheated). For TP
 * states: -999 = subcooled liquid, 999 = superheated vapor / supercritical.
 * @param {string} fluid Fluid name
 * @param {string} inpCode Input pair: "PH","PS","TQ","PQ","TP"
 * @param {string} units "SI", "SIC" or "E" (optional, default "SI")
 * @param {number} prop1 First input property
 * @param {number} prop2 Second input property
 * @return {number} Quality [-]
 * @customfunction
 */
function Quality(fluid, inpCode, units, prop1, prop2) { return _prop(fluid, inpCode, units, prop1, prop2, 'Q'); }

/**
 * Saturation (vapor) pressure at a given temperature.
 * Example: =Psat("Water","SI",373.15)  ->  ~101 kPa
 * @param {string} fluid Fluid name
 * @param {string} units "SI", "SIC" or "E" (optional, default "SI")
 * @param {number} temp Temperature
 * @return {number} Saturation pressure [kPa] or [psia]
 * @customfunction
 */
function Psat(fluid, units, temp) {
  var f = _getFluid(fluid);
  if (typeof units === 'number') { temp = units; units = 'SI'; }
  var u = _normUnits(units);
  var T = _Tin(_num(temp, 'temperature'), u);
  return _out(_psat(f, T) / 1000, 'P', u);
}

/**
 * Saturation temperature at a given pressure.
 * Example: =Tsat("Water","SI",101.325)  ->  ~373 K
 * @param {string} fluid Fluid name
 * @param {string} units "SI", "SIC" or "E" (optional, default "SI")
 * @param {number} pres Pressure
 * @return {number} Saturation temperature [K], [degC] or [degF]
 * @customfunction
 */
function Tsat(fluid, units, pres) {
  var f = _getFluid(fluid);
  if (typeof units === 'number') { pres = units; units = 'SI'; }
  var u = _normUnits(units);
  var P = _Pin(_num(pres, 'pressure'), u);
  return _out(_tsat(f, P), 'T', u);
}

/**
 * Enthalpy of vaporization (latent heat) at a given temperature.
 * @param {string} fluid Fluid name
 * @param {string} units "SI", "SIC" or "E" (optional, default "SI")
 * @param {number} temp Temperature
 * @return {number} hfg [kJ/kg] or [Btu/lb]
 * @customfunction
 */
function LatentHeat(fluid, units, temp) {
  var f = _getFluid(fluid);
  if (typeof units === 'number') { temp = units; units = 'SI'; }
  var u = _normUnits(units);
  var T = _Tin(_num(temp, 'temperature'), u);
  var sat = _satTv(f, T);
  return _out((sat.V.h - sat.L.h) / f.M / 1000, 'HFG', u);
}

/**
 * Molar mass of a fluid.
 * @param {string} fluid Fluid name
 * @return {number} Molar mass [g/mol]
 * @customfunction
 */
function MolarMass(fluid) { return _getFluid(fluid).M * 1000; }

/**
 * Critical temperature of a fluid.
 * @param {string} fluid Fluid name
 * @param {string} units "SI", "SIC" or "E" (optional, default "SI")
 * @return {number} Tc [K], [degC] or [degF]
 * @customfunction
 */
function CriticalTemperature(fluid, units) { return _out(_getFluid(fluid).Tc, 'T', _normUnits(units)); }

/**
 * Critical pressure of a fluid.
 * @param {string} fluid Fluid name
 * @param {string} units "SI", "SIC" or "E" (optional, default "SI")
 * @return {number} Pc [kPa] or [psia]
 * @customfunction
 */
function CriticalPressure(fluid, units) { return _out(_getFluid(fluid).Pc / 1000, 'P', _normUnits(units)); }

/**
 * Acentric factor of a fluid.
 * @param {string} fluid Fluid name
 * @return {number} omega [-]
 * @customfunction
 */
function AcentricFactor(fluid) { return _getFluid(fluid).w; }

/**
 * Normal boiling point (saturation temperature at 1 atm).
 * @param {string} fluid Fluid name
 * @param {string} units "SI", "SIC" or "E" (optional, default "SI")
 * @return {number} NBP [K], [degC] or [degF]
 * @customfunction
 */
function NormalBoilingPoint(fluid, units) {
  return _out(_tsat(_getFluid(fluid), 101325), 'T', _normUnits(units));
}

/**
 * List of all supported fluids (spills into a column).
 * @return {string[][]} Fluid names
 * @customfunction
 */
function FluidList() {
  var rows = [];
  for (var k in FLUID_DB) rows.push([k, FLUID_DB[k].name]);
  rows.sort(function (a, b) { return a[0] < b[0] ? -1 : 1; });
  rows.unshift(['KEY', 'FLUID']);
  return rows;
}

/* ------------------------------------------------------------------------
 * Run from the Apps Script editor (Run > SelfTest) to verify installation.
 * Results appear in the execution log.
 * ---------------------------------------------------------------------- */
function SelfTest() {
  var lines = [
    'N2 density @300K,101.325kPa  : ' + Density('N2', 'TP', 'SI', 300, 101.325).toFixed(4) + ' kg/m3 (approx 1.138)',
    'Water Tsat @101.325 kPa      : ' + Tsat('Water', 'SI', 101.325).toFixed(2) + ' K (approx 373)',
    'R134a Psat @25 C             : ' + Psat('R134a', 'SIC', 25).toFixed(0) + ' kPa (approx 665)',
    'Steam h @PQ 101.325,1        : ' + Enthalpy('Water', 'PQ', 'SI', 101.325, 1).toFixed(0) + ' kJ/kg',
    'CO2 sound speed @300K,1atm   : ' + SoundSpeed('CO2', 'TP', 'SI', 300, 101.325).toFixed(1) + ' m/s (approx 269)'
  ];
  Logger.log('\n' + lines.join('\n'));
  return lines;
}
