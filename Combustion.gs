/**
 * ============================================================================
 *  RefpropGS - Combustion.gs
 *  Air-fuel mixture properties and combustion stoichiometry helpers.
 *
 *  Requires Code.gs (the main RefpropGS file) in the same Apps Script
 *  project - it reuses the fluid database and Peng-Robinson engine.
 *
 *  Mixing model: Dalton ideal mixing of real-gas components. Each component
 *  is evaluated at (T, its partial pressure p_i = x_i * P), then combined
 *  on a mass basis. This is accurate for unburned gaseous air-fuel mixtures
 *  at engine/burner-relevant conditions and automatically includes the
 *  entropy of mixing.
 *
 *  Fuel ratio types accepted everywhere (ratioType argument):
 *    "AFR"    : air-fuel mass ratio  (kg air / kg fuel)      [default]
 *    "FAR"    : fuel-air mass ratio  (kg fuel / kg air)
 *    "PHI"    : equivalence ratio    (AFRstoich / AFR)
 *    "LAMBDA" : excess-air ratio     (AFR / AFRstoich = 1/phi)
 *
 *  IMPORTANT reference-state note: mixture enthalpies/entropies here are
 *  SENSIBLE values built on each component's own reference state. They are
 *  valid for heating, cooling, and compression of a FIXED composition
 *  (e.g. h2-h1 across a compressor). Do NOT difference enthalpies across
 *  different fuel ratios or across combustion to get heat release - use
 *  LowerHeatingValue() for combustion energy.
 * ============================================================================
 */

/* Elemental composition (atoms per molecule) of combustible fluids.
 * Stoichiometric O2 demand per mole fuel = C + H/4 - O/2
 * (N in the fuel is assumed to go to N2, consuming no O2 - valid for NH3.) */
var FUEL_ATOMS = {
  METHANE:   {C:1, H:4,  O:0},
  ETHANE:    {C:2, H:6,  O:0},
  PROPANE:   {C:3, H:8,  O:0},
  BUTANE:    {C:4, H:10, O:0},
  ISOBUTANE: {C:4, H:10, O:0},
  ETHYLENE:  {C:2, H:4,  O:0},
  PROPYLENE: {C:3, H:6,  O:0},
  HYDROGEN:  {C:0, H:2,  O:0},
  CO:        {C:1, H:0,  O:1},
  METHANOL:  {C:1, H:4,  O:1},
  ETHANOL:   {C:2, H:6,  O:1},
  AMMONIA:   {C:0, H:3,  O:0, N:1},
  DIESEL:    {C:12.3, H:22.2, O:0},   // No.2 diesel surrogate
  JP5:       {C:12,   H:23,   O:0}    // JP-5 / Jet-A / JP-8 surrogate
};

/* Lower heating values [kJ/kg fuel] (standard literature values, ~+/-0.5%) */
var FUEL_LHV = {
  METHANE: 50010, ETHANE: 47480, PROPANE: 46350, BUTANE: 45740,
  ISOBUTANE: 45590, ETHYLENE: 47160, PROPYLENE: 45780, HYDROGEN: 119960,
  CO: 10100, METHANOL: 19930, ETHANOL: 26830, AMMONIA: 18600,
  DIESEL: 42800, JP5: 43000
};

var O2_IN_AIR = 0.20947;   // mole fraction O2 in dry air

function _fuelKey(fluid) {
  var key = String(fluid).toUpperCase().replace(/[\s\-_\.]/g, '');
  if (FLUID_ALIASES[key]) key = FLUID_ALIASES[key];
  if (!FUEL_ATOMS[key]) {
    throw new Error('"' + fluid + '" is not in the fuel database. Fuels: ' +
      Object.keys(FUEL_ATOMS).join(', '));
  }
  return key;
}

function _stoichAFRcalc(key) {
  var at = FUEL_ATOMS[key];
  var fFuel = FLUID_DB[key];
  var molO2 = at.C + at.H / 4 - at.O / 2;
  var molAir = molO2 / O2_IN_AIR;
  return molAir * FLUID_DB.AIR.M / fFuel.M;   // kg air / kg fuel
}

/* Normalize any ratio spec to mass AFR */
function _toAFR(key, ratio, ratioType) {
  var rt = (ratioType === null || ratioType === undefined || ratioType === '')
           ? 'AFR' : String(ratioType).toUpperCase().replace(/[^A-Z]/g, '');
  ratio = _num(ratio, 'fuel ratio');
  var st;
  switch (rt) {
    case 'AFR': if (ratio < 0) throw new Error('AFR must be >= 0'); return ratio;
    case 'FAR': if (ratio < 0) throw new Error('FAR must be >= 0');
                if (ratio === 0) return Infinity; return 1 / ratio;
    case 'PHI': if (ratio < 0) throw new Error('PHI must be >= 0');
                st = _stoichAFRcalc(key);
                if (ratio === 0) return Infinity; return st / ratio;
    case 'LAMBDA': if (ratio < 0) throw new Error('LAMBDA must be >= 0');
                st = _stoichAFRcalc(key);
                return st * ratio;
    default: throw new Error('Unknown ratioType "' + ratioType + '". Use "AFR", "FAR", "PHI" or "LAMBDA".');
  }
}

/* Component states of the unburned mixture at (T, P_total) via Dalton.
 * Returns mass fractions, mole fractions and raw component states. */
function _mixStates(fuelKey, T, P, AFR) {
  var fF = FLUID_DB[fuelKey], fA = FLUID_DB.AIR;
  var wf, wa;
  if (!isFinite(AFR)) { wf = 0; wa = 1; }
  else { wf = 1 / (1 + AFR); wa = AFR / (1 + AFR); }

  var nf = wf / fF.M, na = wa / fA.M;          // moles per kg mixture
  var xf = nf / (nf + na), xa = na / (nf + na);
  var Mmix = xf * fF.M + xa * fA.M;

  var out = { wf: wf, wa: wa, xf: xf, xa: xa, Mmix: Mmix, fF: fF, fA: fA };

  if (wf > 0) {
    var pF = Math.max(xf * P, 1e-3);
    // condensation check: fuel partial pressure vs its vapor pressure
    if (T < fF.Tc && pF >= _psat(fF, T)) {
      throw new Error(fF.name + ' would condense at these conditions ' +
        '(partial pressure ' + (pF / 1000).toFixed(1) + ' kPa exceeds its vapor pressure). ' +
        'Increase T or use a leaner mixture.');
    }
    out.stF = _stateTP(fF, T, pF);
  }
  if (wa > 0) out.stA = _stateTP(fA, T, Math.max(xa * P, 1e-3));
  return out;
}

/* Shared front end: parse args (units optional), return mass-based SI value */
function _mixProp(fuel, units, T, P, ratio, ratioType, key) {
  var fk = _fuelKey(fuel);
  if (typeof units === 'number') {           // units omitted -> shift args
    ratioType = ratio; ratio = P; P = T; T = units; units = 'SI';
  }
  var u = _normUnits(units);
  var Tk = _Tin(_num(T, 'temperature'), u);
  var Pp = _Pin(_num(P, 'pressure'), u);
  var AFR = _toAFR(fk, ratio, ratioType);
  var m = _mixStates(fk, Tk, Pp, AFR);

  var offF = m.wf > 0 ? _refOff(m.fF) : null;
  var offA = _refOff(m.fA);

  function comp(prop) {   // mass-weighted sum of a referenced component property
    var v = 0;
    if (m.wf > 0) {
      var st = m.stF;
      var val = prop === 'h' ? (st.h - offF.h) : prop === 's' ? (st.s - offF.s) :
                prop === 'cp' ? st.cp : st.cv;
      v += m.wf * val / m.fF.M / 1000;
    }
    if (m.wa > 0) {
      var sa = m.stA;
      var va = prop === 'h' ? (sa.h - offA.h) : prop === 's' ? (sa.s - offA.s) :
               prop === 'cp' ? sa.cp : sa.cv;
      v += m.wa * va / m.fA.M / 1000;
    }
    return v;
  }

  switch (key) {
    case 'H':  return _out(comp('h'), 'H', u);
    case 'S':  return _out(comp('s'), 'S', u);
    case 'CP': return _out(comp('cp'), 'CP', u);
    case 'CV': return _out(comp('cv'), 'CV', u);
    case 'D': {
      // Dalton: Zmix = sum(x_i * Z_i at partial pressure)
      var Zm = (m.wf > 0 ? m.xf * m.stF.Z : 0) + (m.wa > 0 ? m.xa * m.stA.Z : 0);
      var d = Pp * m.Mmix / (Zm * RGAS * Tk);
      return _out(d, 'D', u);
    }
    case 'M':  return m.Mmix * 1000;
  }
}

/* ========================================================================
 *  CUSTOM SPREADSHEET FUNCTIONS
 * ====================================================================== */

/**
 * Specific enthalpy of an unburned air-fuel mixture, per kg of mixture.
 * Sensible enthalpy: valid for fixed-composition heating/compression only.
 * Example: =MixtureEnthalpy("Methane","SI",300,101.325,17.2,"AFR")
 *          =MixtureEnthalpy("Propane","SIC",25,101.325,1,"PHI")
 * @param {string} fuel Fuel name (e.g. "Methane","Propane","Hydrogen","Ethanol")
 * @param {string} units "SI" (K,kPa), "SIC" (degC,kPa) or "E" (degF,psia). Optional, default "SI".
 * @param {number} temp Temperature
 * @param {number} pres Total pressure
 * @param {number} ratio Fuel-ratio value
 * @param {string} ratioType "AFR" (default), "FAR", "PHI" or "LAMBDA"
 * @return {number} Mixture enthalpy [kJ/kg] or [Btu/lb]
 * @customfunction
 */
function MixtureEnthalpy(fuel, units, temp, pres, ratio, ratioType) {
  return _mixProp(fuel, units, temp, pres, ratio, ratioType, 'H');
}

/**
 * Specific entropy of an unburned air-fuel mixture (includes mixing entropy
 * via Dalton partial pressures). Fixed-composition comparisons only.
 * @param {string} fuel Fuel name
 * @param {string} units "SI", "SIC" or "E" (optional, default "SI")
 * @param {number} temp Temperature
 * @param {number} pres Total pressure
 * @param {number} ratio Fuel-ratio value
 * @param {string} ratioType "AFR" (default), "FAR", "PHI" or "LAMBDA"
 * @return {number} Mixture entropy [kJ/kg-K] or [Btu/lb-R]
 * @customfunction
 */
function MixtureEntropy(fuel, units, temp, pres, ratio, ratioType) {
  return _mixProp(fuel, units, temp, pres, ratio, ratioType, 'S');
}

/**
 * Isobaric heat capacity of an unburned air-fuel mixture.
 * @param {string} fuel Fuel name
 * @param {string} units "SI", "SIC" or "E" (optional, default "SI")
 * @param {number} temp Temperature
 * @param {number} pres Total pressure
 * @param {number} ratio Fuel-ratio value
 * @param {string} ratioType "AFR" (default), "FAR", "PHI" or "LAMBDA"
 * @return {number} Mixture cp [kJ/kg-K] or [Btu/lb-R]
 * @customfunction
 */
function MixtureCp(fuel, units, temp, pres, ratio, ratioType) {
  return _mixProp(fuel, units, temp, pres, ratio, ratioType, 'CP');
}

/**
 * Isochoric heat capacity of an unburned air-fuel mixture.
 * @param {string} fuel Fuel name
 * @param {string} units "SI", "SIC" or "E" (optional, default "SI")
 * @param {number} temp Temperature
 * @param {number} pres Total pressure
 * @param {number} ratio Fuel-ratio value
 * @param {string} ratioType "AFR" (default), "FAR", "PHI" or "LAMBDA"
 * @return {number} Mixture cv [kJ/kg-K] or [Btu/lb-R]
 * @customfunction
 */
function MixtureCv(fuel, units, temp, pres, ratio, ratioType) {
  return _mixProp(fuel, units, temp, pres, ratio, ratioType, 'CV');
}

/**
 * Density of an unburned air-fuel mixture (Dalton real-gas mixing).
 * @param {string} fuel Fuel name
 * @param {string} units "SI", "SIC" or "E" (optional, default "SI")
 * @param {number} temp Temperature
 * @param {number} pres Total pressure
 * @param {number} ratio Fuel-ratio value
 * @param {string} ratioType "AFR" (default), "FAR", "PHI" or "LAMBDA"
 * @return {number} Mixture density [kg/m3] or [lbm/ft3]
 * @customfunction
 */
function MixtureDensity(fuel, units, temp, pres, ratio, ratioType) {
  return _mixProp(fuel, units, temp, pres, ratio, ratioType, 'D');
}

/**
 * Molar mass of an air-fuel mixture at the given fuel ratio.
 * Example: =MixtureMolarMass("Methane",17.2,"AFR")
 * @param {string} fuel Fuel name
 * @param {number} ratio Fuel-ratio value
 * @param {string} ratioType "AFR" (default), "FAR", "PHI" or "LAMBDA"
 * @return {number} Molar mass [g/mol]
 * @customfunction
 */
function MixtureMolarMass(fuel, ratio, ratioType) {
  var fk = _fuelKey(fuel);
  var AFR = _toAFR(fk, ratio, ratioType);
  return _mixStates(fk, 300, 101325, AFR).Mmix * 1000;
}

/**
 * Stoichiometric air-fuel mass ratio of a fuel burned in dry air.
 * Example: =StoichAFR("Methane") -> ~17.2
 * @param {string} fuel Fuel name
 * @return {number} AFR_stoich [kg air / kg fuel]
 * @customfunction
 */
function StoichAFR(fuel) { return _stoichAFRcalc(_fuelKey(fuel)); }

/**
 * Equivalence ratio phi from a mass air-fuel ratio (phi = AFRstoich / AFR).
 * @param {string} fuel Fuel name
 * @param {number} afr Air-fuel mass ratio
 * @return {number} phi [-]
 * @customfunction
 */
function EquivalenceRatio(fuel, afr) {
  var fk = _fuelKey(fuel);
  _num(afr, 'AFR');
  if (afr <= 0) throw new Error('AFR must be positive.');
  return _stoichAFRcalc(fk) / afr;
}

/**
 * Air-fuel mass ratio from an equivalence ratio (AFR = AFRstoich / phi).
 * @param {string} fuel Fuel name
 * @param {number} phi Equivalence ratio
 * @return {number} AFR [kg air / kg fuel]
 * @customfunction
 */
function AFRFromPhi(fuel, phi) {
  var fk = _fuelKey(fuel);
  _num(phi, 'phi');
  if (phi <= 0) throw new Error('phi must be positive.');
  return _stoichAFRcalc(fk) / phi;
}

/**
 * Lower heating value of a fuel.
 * @param {string} fuel Fuel name
 * @param {string} units "SI"/"SIC" -> kJ/kg, "E" -> Btu/lb (optional, default "SI")
 * @return {number} LHV [kJ/kg] or [Btu/lb]
 * @customfunction
 */
function LowerHeatingValue(fuel, units) {
  var fk = _fuelKey(fuel);
  return _out(FUEL_LHV[fk], 'H', _normUnits(units));
}

/**
 * Heat released per kg of MIXTURE at complete combustion:
 * LHV * (fuel mass fraction). Handy for energy balances per kg charge.
 * For rich mixtures (phi > 1) only the air-limited fraction of fuel burns.
 * @param {string} fuel Fuel name
 * @param {number} ratio Fuel-ratio value
 * @param {string} ratioType "AFR" (default), "FAR", "PHI" or "LAMBDA"
 * @param {string} units "SI"/"SIC" -> kJ/kg, "E" -> Btu/lb (optional, default "SI")
 * @return {number} Specific heat release [kJ/kg mixture] or [Btu/lb mixture]
 * @customfunction
 */
function MixtureHeatRelease(fuel, ratio, ratioType, units) {
  var fk = _fuelKey(fuel);
  var AFR = _toAFR(fk, ratio, ratioType);
  if (!isFinite(AFR)) return 0;
  var wf = 1 / (1 + AFR);
  var st = _stoichAFRcalc(fk);
  var burnedFrac = Math.min(1, AFR / st);   // air-limited when rich
  return _out(FUEL_LHV[fk] * wf * burnedFrac, 'H', _normUnits(units));
}

/**
 * List of supported fuels with stoichiometric AFR and LHV (spills).
 * @return {(string|number)[][]}
 * @customfunction
 */
function FuelList() {
  var rows = [['FUEL', 'AFR_STOICH [kg/kg]', 'LHV [kJ/kg]']];
  for (var k in FUEL_ATOMS) {
    rows.push([FLUID_DB[k].name, Math.round(_stoichAFRcalc(k) * 100) / 100, FUEL_LHV[k]]);
  }
  return rows;
}

/* ========================================================================
 *  COMBUSTION PRODUCTS (burned gas)
 *
 *  Complete lean-to-stoichiometric combustion (phi <= 1) in dry air:
 *  products are CO2, H2O, N2, O2 (excess), and Ar, mixed with the same
 *  Dalton real-gas approach. Composition is FIXED for a given fuel and
 *  ratio, so enthalpy/entropy DIFFERENCES across a turbine, nozzle, or
 *  heat exchanger are fully valid. Rich mixtures (phi > 1) require
 *  CO/H2 equilibrium chemistry and are rejected with an error.
 *
 *  Ideal-gas cp polynomials are valid to roughly 1800 K; beyond that,
 *  extrapolation error grows.
 * ====================================================================== */

/* Dry-air composition (mole fractions, Ar-inclusive, normalized) */
var AIR_X = { N2: 0.78112, O2: 0.20954, AR: 0.00934 };

/* Product composition for 1 mol fuel + air at mass ratio AFR.
 * Returns [{f, x}] with mole fractions and mixture molar mass. */
function _prodComp(fuelKey, AFR) {
  var at = FUEL_ATOMS[fuelKey];
  var fF = FLUID_DB[fuelKey];
  var st = _stoichAFRcalc(fuelKey);
  if (AFR < st * (1 - 1e-9)) {
    var phi = st / AFR;
    throw new Error('Rich mixture (phi = ' + phi.toFixed(3) + ' > 1): incomplete-combustion ' +
      'products (CO/H2 equilibrium) are not modeled. Use phi <= 1.');
  }
  var nAir = AFR * fF.M / FLUID_DB.AIR.M;          // mol air per mol fuel
  var nO2need = at.C + at.H / 4 - (at.O || 0) / 2;
  var n = {
    CO2:      at.C,
    WATER:    at.H / 2,
    OXYGEN:   AIR_X.O2 * nAir - nO2need,
    NITROGEN: AIR_X.N2 * nAir + (at.N || 0) / 2,
    ARGON:    AIR_X.AR * nAir
  };
  if (n.OXYGEN < -1e-9) throw new Error('Internal oxygen-balance error.');
  n.OXYGEN = Math.max(n.OXYGEN, 0);
  var tot = 0, k;
  for (k in n) tot += n[k];
  var comp = [], Mmix = 0;
  for (k in n) {
    if (n[k] / tot > 1e-12) {
      var x = n[k] / tot;
      comp.push({ f: FLUID_DB[k], x: x });
      Mmix += x * FLUID_DB[k].M;
    }
  }
  return { comp: comp, Mmix: Mmix };
}

/* Mass-based SI property of the burned-gas mixture at (T, P) */
function _prodPropTP(pc, T, P, key) {
  var i, c, sum = 0, Zm = 0;
  for (i = 0; i < pc.comp.length; i++) {
    c = pc.comp[i];
    var pi = Math.max(c.x * P, 1e-3);
    if (c.f === FLUID_DB.WATER && T < c.f.Tc && pi >= _psat(c.f, T)) {
      throw new Error('Water in the products would condense at these conditions ' +
        '(below the dew point, ~' + (_tsat(c.f, pi)).toFixed(1) + ' K at this water partial pressure). ' +
        'Use a higher temperature.');
    }
    var stI = _stateTP(c.f, T, pi);
    var w = c.x * c.f.M / pc.Mmix;
    var off = _refOff(c.f);
    switch (key) {
      case 'H':  sum += w * (stI.h - off.h) / c.f.M / 1000; break;
      case 'S':  sum += w * (stI.s - off.s) / c.f.M / 1000; break;
      case 'CP': sum += w * stI.cp / c.f.M / 1000; break;
      case 'CV': sum += w * stI.cv / c.f.M / 1000; break;
      case 'D':  Zm += c.x * stI.Z; break;
    }
  }
  if (key === 'D') return P * pc.Mmix / (Zm * RGAS * T);
  return sum;
}

function _prodProp(fuel, units, T, P, ratio, ratioType, key) {
  var fk = _fuelKey(fuel);
  if (typeof units === 'number') {
    ratioType = ratio; ratio = P; P = T; T = units; units = 'SI';
  }
  var u = _normUnits(units);
  var Tk = _Tin(_num(T, 'temperature'), u);
  var Pp = _Pin(_num(P, 'pressure'), u);
  var pc = _prodComp(fk, _toAFR(fk, ratio, ratioType));
  var outKey = key === 'CP' || key === 'CV' ? key : key;   // same keys as _out
  return _out(_prodPropTP(pc, Tk, Pp, key), key === 'H' ? 'H' : key === 'S' ? 'S' :
              key === 'CP' ? 'CP' : key === 'CV' ? 'CV' : 'D', u);
}

/**
 * Specific enthalpy of complete-combustion products (CO2/H2O/N2/O2/Ar),
 * per kg of burned gas. Composition is fixed by fuel + ratio, so
 * differences across a turbine or nozzle at the same ratio are valid.
 * Example: =ProductsEnthalpy("Methane","SI",1400,1000,0.4,"PHI")
 * @param {string} fuel Fuel name
 * @param {string} units "SI", "SIC" or "E" (optional, default "SI")
 * @param {number} temp Temperature
 * @param {number} pres Total pressure
 * @param {number} ratio Fuel-ratio value (phi <= 1)
 * @param {string} ratioType "AFR" (default), "FAR", "PHI" or "LAMBDA"
 * @return {number} Enthalpy [kJ/kg] or [Btu/lb]
 * @customfunction
 */
function ProductsEnthalpy(fuel, units, temp, pres, ratio, ratioType) {
  return _prodProp(fuel, units, temp, pres, ratio, ratioType, 'H');
}

/**
 * Specific entropy of complete-combustion products (Dalton mixing included).
 * @param {string} fuel Fuel name
 * @param {string} units "SI", "SIC" or "E" (optional, default "SI")
 * @param {number} temp Temperature
 * @param {number} pres Total pressure
 * @param {number} ratio Fuel-ratio value (phi <= 1)
 * @param {string} ratioType "AFR" (default), "FAR", "PHI" or "LAMBDA"
 * @return {number} Entropy [kJ/kg-K] or [Btu/lb-R]
 * @customfunction
 */
function ProductsEntropy(fuel, units, temp, pres, ratio, ratioType) {
  return _prodProp(fuel, units, temp, pres, ratio, ratioType, 'S');
}

/**
 * Isobaric heat capacity of complete-combustion products.
 * @param {string} fuel Fuel name
 * @param {string} units "SI", "SIC" or "E" (optional, default "SI")
 * @param {number} temp Temperature
 * @param {number} pres Total pressure
 * @param {number} ratio Fuel-ratio value (phi <= 1)
 * @param {string} ratioType "AFR" (default), "FAR", "PHI" or "LAMBDA"
 * @return {number} cp [kJ/kg-K] or [Btu/lb-R]
 * @customfunction
 */
function ProductsCp(fuel, units, temp, pres, ratio, ratioType) {
  return _prodProp(fuel, units, temp, pres, ratio, ratioType, 'CP');
}

/**
 * Isochoric heat capacity of complete-combustion products.
 * @param {string} fuel Fuel name
 * @param {string} units "SI", "SIC" or "E" (optional, default "SI")
 * @param {number} temp Temperature
 * @param {number} pres Total pressure
 * @param {number} ratio Fuel-ratio value (phi <= 1)
 * @param {string} ratioType "AFR" (default), "FAR", "PHI" or "LAMBDA"
 * @return {number} cv [kJ/kg-K] or [Btu/lb-R]
 * @customfunction
 */
function ProductsCv(fuel, units, temp, pres, ratio, ratioType) {
  return _prodProp(fuel, units, temp, pres, ratio, ratioType, 'CV');
}

/**
 * Density of complete-combustion products (Dalton real-gas mixing).
 * @param {string} fuel Fuel name
 * @param {string} units "SI", "SIC" or "E" (optional, default "SI")
 * @param {number} temp Temperature
 * @param {number} pres Total pressure
 * @param {number} ratio Fuel-ratio value (phi <= 1)
 * @param {string} ratioType "AFR" (default), "FAR", "PHI" or "LAMBDA"
 * @return {number} Density [kg/m3] or [lbm/ft3]
 * @customfunction
 */
function ProductsDensity(fuel, units, temp, pres, ratio, ratioType) {
  return _prodProp(fuel, units, temp, pres, ratio, ratioType, 'D');
}

/* T [K] from (P [Pa], target h or s [SI mass]) for a fixed product mix */
function _prodTfromPX(pc, P, X, key) {
  var Tlo = 220, Thi = 2400;
  var g = function (T) { return _prodPropTP(pc, T, P, key) - X; };
  var glo, ghi;
  for (var i = 0; i < 20; i++) {           // lift lower bound above dew point
    try { glo = g(Tlo); break; } catch (e) { Tlo += 15; }
  }
  ghi = g(Thi);
  if (glo === undefined || glo * ghi > 0) {
    throw new Error('No product-gas temperature found for the given P and ' + key +
      ' (target outside 220-2400 K range or below the dew point).');
  }
  var Tm = Tlo;
  for (var it = 0; it < 90; it++) {
    Tm = 0.5 * (Tlo + Thi);
    var gm = g(Tm);
    if (gm === 0 || (Thi - Tlo) < 1e-8 * Tm) break;
    if (glo * gm < 0) { Thi = Tm; } else { Tlo = Tm; glo = gm; }
  }
  return Tm;
}

/* (P, T) from (h, s) for a fixed product mix. At constant h, entropy falls
 * monotonically with pressure, so bisection on ln P is safe. */
function _prodPfromHS(pc, H, S) {
  var lnLo = Math.log(100), lnHi = Math.log(1e8);   // 0.1 kPa .. 100 MPa
  function sAt(lnP) {
    var P = Math.exp(lnP);
    return _prodPropTP(pc, _prodTfromPX(pc, P, H, 'H'), P, 'S') - S;
  }
  var gLo = null, gHi = null;
  for (var i = 0; i < 20 && gLo === null; i++) {
    try { gLo = sAt(lnLo); } catch (e) { lnLo += 0.6; }
  }
  for (var j = 0; j < 20 && gHi === null; j++) {
    try { gHi = sAt(lnHi); } catch (e) { lnHi -= 0.6; }
  }
  if (gLo === null || gHi === null || gLo * gHi > 0) {
    throw new Error('No product-gas pressure found for the given H and S ' +
      '(state outside computable range).');
  }
  var lnM = lnLo;
  for (var it = 0; it < 90; it++) {
    lnM = 0.5 * (lnLo + lnHi);
    var gm = sAt(lnM);
    if (gm === 0 || (lnHi - lnLo) < 1e-11) break;
    if (gLo * gm < 0) { lnHi = lnM; } else { lnLo = lnM; gLo = gm; }
  }
  var Pf = Math.exp(lnM);
  return { P: Pf, T: _prodTfromPX(pc, Pf, H, 'H') };
}

/* Shared parse for products inversion functions */
function _prodInvParse(fuel, inpCode, units, prop1, prop2, ratio, ratioType) {
  var fk = _fuelKey(fuel);
  if (typeof units === 'number') {
    ratioType = ratio; ratio = prop2; prop2 = prop1; prop1 = units; units = 'SI';
  }
  var u = _normUnits(units);
  var code = String(inpCode).toUpperCase().replace(/[^A-Z]/g, '');
  if (code === 'HP' || code === 'SP' || code === 'SH') {   // reversed order
    code = code.charAt(1) + code.charAt(0);
    var tmp = prop1; prop1 = prop2; prop2 = tmp;
  }
  var pc = _prodComp(fk, _toAFR(fk, ratio, ratioType));
  function toH(x) { return u === 'E' ? x * 2.326 : x; }
  function toS(x) { return u === 'E' ? x * 4.1868 : x; }
  var out = { u: u, code: code, pc: pc };
  if (code === 'PH') { out.P = _Pin(_num(prop1, 'pressure'), u); out.X = toH(_num(prop2, 'enthalpy')); out.key = 'H'; }
  else if (code === 'PS') { out.P = _Pin(_num(prop1, 'pressure'), u); out.X = toS(_num(prop2, 'entropy')); out.key = 'S'; }
  else if (code === 'HS') { out.H = toH(_num(prop1, 'enthalpy')); out.S = toS(_num(prop2, 'entropy')); }
  else throw new Error('Supported input codes: "PH", "PS", "HS".');
  return out;
}

/**
 * Temperature of combustion products from "PH" (P, h), "PS" (P, s) or
 * "HS" (h, s). Enables isentropic turbine/nozzle calculations:
 *   T2s = ProductsTemperature("JP5","PS","SI", P2, s1, ratio, rt)
 * @param {string} fuel Fuel name
 * @param {string} inpCode "PH", "PS" or "HS"
 * @param {string} units "SI", "SIC" or "E" (optional, default "SI")
 * @param {number} prop1 Pressure (PH/PS) or enthalpy (HS)
 * @param {number} prop2 Enthalpy (PH), entropy (PS/HS)
 * @param {number} ratio Fuel-ratio value (phi <= 1)
 * @param {string} ratioType "AFR" (default), "FAR", "PHI" or "LAMBDA"
 * @return {number} Temperature [K], [degC] or [degF]
 * @customfunction
 */
function ProductsTemperature(fuel, inpCode, units, prop1, prop2, ratio, ratioType) {
  var a = _prodInvParse(fuel, inpCode, units, prop1, prop2, ratio, ratioType);
  var T = (a.code === 'HS') ? _prodPfromHS(a.pc, a.H, a.S).T
                            : _prodTfromPX(a.pc, a.P, a.X, a.key);
  return _out(T, 'T', a.u);
}

/**
 * Pressure of combustion products from "HS" (h, s) - or trivially from
 * "PH"/"PS". Closes the isentropic-turbine loop:
 *   P2 = ProductsPressure("JP5","HS","SI", h2s, s1, ratio, rt)
 * @param {string} fuel Fuel name
 * @param {string} inpCode "HS" (also accepts "PH","PS")
 * @param {string} units "SI", "SIC" or "E" (optional, default "SI")
 * @param {number} prop1 Enthalpy (HS) or pressure (PH/PS)
 * @param {number} prop2 Entropy (HS/PS) or enthalpy (PH)
 * @param {number} ratio Fuel-ratio value (phi <= 1)
 * @param {string} ratioType "AFR" (default), "FAR", "PHI" or "LAMBDA"
 * @return {number} Pressure [kPa] or [psia]
 * @customfunction
 */
function ProductsPressure(fuel, inpCode, units, prop1, prop2, ratio, ratioType) {
  var a = _prodInvParse(fuel, inpCode, units, prop1, prop2, ratio, ratioType);
  var Ppa = (a.code === 'HS') ? _prodPfromHS(a.pc, a.H, a.S).P : a.P;
  return _out(Ppa / 1000, 'P', a.u);
}

/**
 * Molar mass of the burned-gas mixture.
 * @param {string} fuel Fuel name
 * @param {number} ratio Fuel-ratio value (phi <= 1)
 * @param {string} ratioType "AFR" (default), "FAR", "PHI" or "LAMBDA"
 * @return {number} Molar mass [g/mol]
 * @customfunction
 */
function ProductsMolarMass(fuel, ratio, ratioType) {
  var fk = _fuelKey(fuel);
  return _prodComp(fk, _toAFR(fk, ratio, ratioType)).Mmix * 1000;
}

/**
 * Mole-fraction breakdown of the combustion products (spills as a table).
 * Example: =ProductsComposition("Methane",1,"PHI")
 * @param {string} fuel Fuel name
 * @param {number} ratio Fuel-ratio value (phi <= 1)
 * @param {string} ratioType "AFR" (default), "FAR", "PHI" or "LAMBDA"
 * @return {(string|number)[][]}
 * @customfunction
 */
function ProductsComposition(fuel, ratio, ratioType) {
  var fk = _fuelKey(fuel);
  var pc = _prodComp(fk, _toAFR(fk, ratio, ratioType));
  var rows = [['SPECIES', 'MOLE FRACTION']];
  pc.comp.sort(function (a, b) { return b.x - a.x; });
  for (var i = 0; i < pc.comp.length; i++) {
    rows.push([pc.comp[i].f.name, Math.round(pc.comp[i].x * 1e6) / 1e6]);
  }
  return rows;
}

/* ========================================================================
 *  COMBUSTOR ENERGY BALANCE
 * ====================================================================== */

/* Ideal-gas sensible enthalpy of the product mix between 298.15 K and T,
 * [kJ/kg]. Uses the NASA/hybrid cp0 directly (water as vapor, matching the
 * LHV convention) so it is valid below the dew point where the real-gas
 * path is blocked. Pressure dependence of h is negligible here. */
function _prodDh298(pc, T) {
  var sum = 0;
  for (var i = 0; i < pc.comp.length; i++) {
    var c = pc.comp[i];
    var w = c.x * c.f.M / pc.Mmix;
    sum += w * (_h0(c.f, T) - _h0(c.f, 298.15)) / c.f.M / 1000;
  }
  return sum;
}

/**
 * Fuel-air mass ratio required to heat combustion air from T3 to a fixed
 * turbine-inlet temperature T4 (adiabatic combustor energy balance,
 * anchored at 298.15 K where LHV is defined; fuel assumed to enter near
 * 298 K, water as vapor). Iterates so the product composition is
 * consistent with the returned f. This is the correct way to compute
 * fuel burn - do NOT difference ProductsEnthalpy against Enthalpy("Air"),
 * as those are on different reference states.
 * Example: =FuelAirRatio("JP5","SI",700,1400,1)   (etaB = 1)
 * @param {string} fuel Fuel name
 * @param {string} units "SI", "SIC" or "E" (optional, default "SI")
 * @param {number} t3 Compressor-exit / combustor-inlet air temperature
 * @param {number} t4 Combustor-exit / turbine-inlet temperature
 * @param {number} etaB Combustion efficiency 0-1 (optional, default 1)
 * @return {number} f = kg fuel / kg air (AFR = 1/f)
 * @customfunction
 */
function FuelAirRatio(fuel, units, t3, t4, etaB) {
  var fk = _fuelKey(fuel);
  if (typeof units === 'number') { etaB = t4; t4 = t3; t3 = units; units = 'SI'; }
  var u = _normUnits(units);
  var T3 = _Tin(_num(t3, 'T3'), u);
  var T4 = _Tin(_num(t4, 'T4'), u);
  if (etaB === null || etaB === undefined || etaB === '') etaB = 1;
  _num(etaB, 'etaB');
  if (etaB <= 0 || etaB > 1) throw new Error('etaB must be in (0, 1].');
  if (T4 <= T3) throw new Error('T4 must exceed T3.');

  var fAir = FLUID_DB.AIR;
  var dhA = (_h0(fAir, T3) - _h0(fAir, 298.15)) / fAir.M / 1000;   // kJ/kg air
  var LHV = FUEL_LHV[fk];
  var stAFR = _stoichAFRcalc(fk);

  // initial guess from a cp*dT estimate, then fixed-point iterate on
  // composition:  f*LHV*etaB + dhA = (1+f)*dh_products(T4; f)
  var f = 1.15 * (T4 - T3) / LHV;
  for (var it = 0; it < 50; it++) {
    var AFR = 1 / f;
    if (AFR < stAFR) throw new Error('Required fuel exceeds stoichiometric ' +
      '(T4 too high for this T3); rich combustion is not modeled.');
    var pc = _prodComp(fk, AFR);
    // solve f*LHV*etaB + dhA = (1+f)*dhP  ->  f = (dhP - dhA) / (LHV*etaB - dhP)
    var dhP = _prodDh298(pc, T4);
    var fNew = (dhP - dhA) / (LHV * etaB - dhP);
    if (fNew <= 0) throw new Error('No physical fuel-air ratio found (check T3, T4, LHV).');
    if (Math.abs(fNew - f) < 1e-12) { f = fNew; break; }
    f = fNew;
  }
  return f;
}
