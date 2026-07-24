# RefpropGS — REFPROP-Style Fluid Properties for Google Sheets

RefpropGS adds custom spreadsheet functions to Google Sheets that work like the NIST REFPROP Excel add-in. You call a function with a fluid name, an input-pair code, a units system, and two state properties, and it returns the thermodynamic property you asked for:

```
=Density("R134a", "TP", "SI", 300, 500)        → 21.53 kg/m³
=Enthalpy("Water", "PQ", "SI", 101.325, 1)     → vapor enthalpy at 1 atm
=Temperature("Propane", "PH", "SI", 1000, 650) → T from pressure + enthalpy
=Psat("CO2", "SIC", 0)                         → 3478 kPa
```

**Important:** this package is not affiliated with NIST and does not call the licensed REFPROP library (which is compiled FORTRAN and cannot run inside Google Sheets). Properties are computed from the Peng-Robinson cubic equation of state with full departure functions, a fugacity-equality saturation solver, and iterative PH/PS flashes. Accuracy is engineering-grade, not reference-grade — see "Accuracy" below before using results for anything critical.

## Installation

1. Open your Google Sheet.
2. Go to **Extensions → Apps Script**.
3. Delete any placeholder code in the editor, and paste the entire contents of `Code.gs`.
4. Click the **Save** icon (or Ctrl+S). Name the project anything, e.g. "RefpropGS".
5. Return to your sheet. The functions are now available immediately — type `=Density(` in any cell and the autocomplete help will appear.
6. Optional: in the Apps Script editor, select the `SelfTest` function in the toolbar and click **Run** to verify the install (results appear in the execution log).

No permissions or authorizations are requested — the script does pure math and never accesses external services or your data.

## Function reference

All property functions share the signature `(Fluid, InputCode, Units, Prop1, Prop2)`, matching the REFPROP Excel add-in style. The `Units` argument may be omitted, in which case "SI" is assumed: `=Density("N2","TP",300,101.325)` works.

| Function | Returns | SI / SIC units | E units |
|---|---|---|---|
| `Density` | density | kg/m³ | lbm/ft³ |
| `Volume` | specific volume | m³/kg | ft³/lbm |
| `Enthalpy` | specific enthalpy | kJ/kg | Btu/lb |
| `Entropy` | specific entropy | kJ/(kg·K) | Btu/(lb·°R) |
| `InternalEnergy` | specific internal energy | kJ/kg | Btu/lb |
| `Cp` | isobaric heat capacity | kJ/(kg·K) | Btu/(lb·°R) |
| `Cv` | isochoric heat capacity | kJ/(kg·K) | Btu/(lb·°R) |
| `SoundSpeed` | speed of sound | m/s | ft/s |
| `Compressibility` | Z = Pv/RT | — | — |
| `Temperature` | temperature | K / °C | °F |
| `Pressure` | pressure | kPa | psia |
| `Quality` | vapor mass fraction | — | — |

Saturation and fluid-constant helpers:

| Function | Signature | Returns |
|---|---|---|
| `Psat` | `(Fluid, [Units], T)` | vapor pressure at T |
| `Tsat` | `(Fluid, [Units], P)` | saturation temperature at P |
| `LatentHeat` | `(Fluid, [Units], T)` | enthalpy of vaporization hfg |
| `NormalBoilingPoint` | `(Fluid, [Units])` | Tsat at 1 atm |
| `CriticalTemperature` | `(Fluid, [Units])` | Tc |
| `CriticalPressure` | `(Fluid, [Units])` | Pc |
| `MolarMass` | `(Fluid)` | g/mol |
| `AcentricFactor` | `(Fluid)` | ω |
| `FluidList` | `()` | spills the full supported-fluid table |

### Input codes

| Code | Inputs | Notes |
|---|---|---|
| `TP` | temperature, pressure | single-phase states |
| `TQ` | temperature, quality (0–1) | saturation / two-phase |
| `PQ` | pressure, quality (0–1) | saturation / two-phase |
| `PH` | pressure, enthalpy | iterative flash; handles two-phase automatically |
| `PS` | pressure, entropy | iterative flash; handles two-phase automatically |
| `HS` | enthalpy, entropy | nested iterative flash; handles two-phase automatically |
| `TD` | temperature, density | direct EOS evaluation |

Letter order is flexible (`"PT"` behaves like `"TP"` with the inputs matched to the letters). Cp, Cv, SoundSpeed, and Compressibility are undefined inside the two-phase dome and return an error there, as in REFPROP.

`Quality` with PH/PS inputs returns the extrapolated quality outside the dome (negative = subcooled, >1 = superheated), which is handy for phase checks. With TP inputs it returns −999 for subcooled liquid and 999 for superheated/supercritical states.

### Units systems

| Code | T | P | Mass/energy props |
|---|---|---|---|
| `"SI"` (default) | K | kPa | kg, kJ |
| `"SIC"` | °C | kPa | kg, kJ |
| `"E"` | °F | psia | lbm, Btu |

### Supported fluids

Water/Steam, Nitrogen, Oxygen, Air, CO2, CO, Argon, Helium, Hydrogen, Methane, Ethane, Propane, n-Butane, Isobutane, Ethylene, Propylene, Ammonia, Methanol, Ethanol, R-134a, R-32, R-125, R-22, R-1234yf, R-410A.

Common aliases work: `"H2O"`, `"Steam"`, `"N2"`, `"R744"`, `"R717"`, `"R290"`, `"R600a"`, etc. Use `=FluidList()` to see everything. R-410A and Air are modeled as pseudo-pure fluids (no glide), so their saturation properties are approximate averages of dew and bubble conditions.

## Example: refrigeration cycle in 4 cells

With evaporator at 5 °C and condenser at 45 °C for R-134a:

```
A1:  =Pressure("R134a","TQ","SIC",5,1)               ' evaporator pressure, kPa
A2:  =Enthalpy("R134a","TQ","SIC",5,1)               ' h1: sat vapor leaving evap
A3:  =Entropy("R134a","TQ","SIC",5,1)                ' s1
A4:  =Enthalpy("R134a","PS","SIC",
        Pressure("R134a","TQ","SIC",45,1), A3)       ' h2s: isentropic compression
A5:  =Enthalpy("R134a","TQ","SIC",45,0)              ' h3: sat liquid leaving cond
A6:  =(A2-A5)/(A4-A2)                                ' ideal COP
```

## Reference states

Default matches REFPROP's "NBP" convention: h = 0 and s = 0 for the saturated liquid at the normal boiling point. Water instead uses the saturated liquid at the triple point (steam-table convention), so cold liquid water enthalpies line up with steam tables. Absolute h and s values from different property packages always differ by constant offsets; differences of enthalpy/entropy between two states are what matter and are directly comparable.

## Accuracy — read this

The Peng-Robinson EOS is the standard workhorse of process simulation, but it is not the multiparameter Helmholtz equations REFPROP uses. Typical deviations from REFPROP/NIST data:

- **Gas and vapor densities, cp, sound speed:** within ~0.1–2 %. Excellent for air, N2, O2, CH4, CO2, steam, and refrigerant vapors at moderate pressures.
- **Vapor pressures:** ~0.1–1 % for nonpolar fluids and common refrigerants; up to ~5 % for water and other polar fluids.
- **Latent heats:** ~2–5 %.
- **Liquid densities:** PR's known weakness — typically 3–10 % low for hydrocarbons and refrigerants, and ~15 % off for liquid water (it predicts ~849 kg/m³ at 25 °C vs the real 997). Do not use this package for liquid water density.
- **Near-critical region (within ~5 K of Tc):** errors grow for all cubic EOS; treat results as qualitative.
- **Helium and hydrogen:** quantum fluids poorly represented by classical cubics; values are rough estimates only.
- Refrigerant ideal-gas heat capacities use linear fits, adding ~1–2 % to their cp/h/s.

Not included: transport properties (viscosity, thermal conductivity, surface tension), mixtures with composition input, and melting/sublimation lines. If you need reference-quality water/steam, an IAPWS-IF97 implementation can be added alongside this — ask and it can be wired in so `"Water"` automatically uses it.

## Combustion module (Combustion.gs)

An optional second script file adds unburned air-fuel mixture properties and combustion stoichiometry. Install it the same way: paste `Combustion.gs` as an additional file in the same Apps Script project (**File → + → Script**, or just append it below the main code). It requires `Code.gs` since it reuses the property engine.

Mixture functions take `(Fuel, Units, T, P, Ratio, RatioType)`. The fuel ratio can be given four ways via `RatioType`: `"AFR"` (kg air/kg fuel, default), `"FAR"` (kg fuel/kg air), `"PHI"` (equivalence ratio), or `"LAMBDA"` (excess-air ratio). Components are mixed with Dalton partial-pressure real-gas mixing, so the entropy of mixing is included automatically, and a guard raises an error if the fuel's partial pressure would exceed its vapor pressure (condensing mixture).

| Function | Returns |
|---|---|
| `MixtureEnthalpy(fuel,u,T,P,r,rt)` | h of the unburned mixture [kJ/kg mix] |
| `MixtureEntropy(fuel,u,T,P,r,rt)` | s incl. mixing entropy [kJ/kg-K] |
| `MixtureCp` / `MixtureCv` | heat capacities [kJ/kg-K] |
| `MixtureDensity` | real-gas mixture density [kg/m³] |
| `MixtureMolarMass(fuel,r,rt)` | g/mol |
| `StoichAFR(fuel)` | stoichiometric air-fuel mass ratio |
| `EquivalenceRatio(fuel,AFR)` / `AFRFromPhi(fuel,phi)` | φ ↔ AFR conversions |
| `LowerHeatingValue(fuel,[u])` | LHV [kJ/kg fuel] |
| `MixtureHeatRelease(fuel,r,rt,[u])` | LHV × burned fuel fraction [kJ/kg mixture]; air-limited when rich |
| `FuelList()` | spills fuels with AFR_stoich and LHV |

Supported fuels: methane, ethane, propane, n-butane, isobutane, ethylene, propylene, hydrogen, CO, methanol, ethanol, ammonia, plus pseudo-fuels **Diesel** (surrogate C12.3H22.2, AFRst = 14.51) and **JP-5** (surrogate C12H23, AFRst = 14.67; aliases `"Jet-A"`, `"JP8"`, `"Kerosene"`). Aliases like `"CH4"`, `"R290"`, `"NH3"` work. The liquid-fuel pseudo-fluids exist primarily for combustion stoichiometry and products; their pure-fluid EOS properties are rough dodecane-like estimates.

Examples:

```
=StoichAFR("Methane")                                    → 17.24
=MixtureEnthalpy("Methane","SIC",25,101.325,1,"PHI")     → h of stoich charge
=MixtureCp("Propane","SI",350,200,0.9,"PHI")
=MixtureHeatRelease("Methane",1,"PHI")                   → 2742 kJ per kg of charge
```

**Reference-state caveat:** `MixtureEnthalpy`/`MixtureEntropy` are *sensible* values built on each component's own reference state. Differences are valid for a **fixed composition** (compression, preheating: h₂−h₁ at the same AFR). Do not difference enthalpies across different fuel ratios or across combustion to obtain heat release — use `LowerHeatingValue`/`MixtureHeatRelease` for the chemical energy term.

### Combustion products (burned gas)

For states *downstream of the combustor* — turbines, nozzles, exhaust heat exchangers — use the `Products*` functions, which model the complete-combustion product mixture (CO2, H2O, N2, excess O2, Ar) at the specified fuel ratio (φ ≤ 1; rich mixtures are rejected since CO/H2 equilibrium isn't modeled). Because composition is fixed for a given fuel + ratio, enthalpy and entropy **differences across a device are fully valid** — this is the correct tool for turbine work per kg of gas.

| Function | Returns |
|---|---|
| `ProductsEnthalpy(fuel,u,T,P,r,rt)` | h of burned gas [kJ/kg] |
| `ProductsEntropy(fuel,u,T,P,r,rt)` | s of burned gas [kJ/kg-K] |
| `ProductsCp` / `ProductsCv` | heat capacities |
| `ProductsDensity` | density [kg/m³] |
| `ProductsTemperature(fuel,"PH"/"PS"/"HS",u,p1,p2,r,rt)` | T from P+h, P+s, or h+s |
| `ProductsPressure(fuel,"HS",u,h,s,r,rt)` | P from h+s (closes turbine loops) |
| `ProductsMolarMass(fuel,r,rt)` | g/mol |
| `ProductsComposition(fuel,r,rt)` | spills species mole fractions |

Isentropic turbine example — methane at φ = 0.45, inlet 1450 K / 1200 kPa, exit 110 kPa:

```
B1: =ProductsEnthalpy("Methane","SI",1450,1200,0.45,"PHI")      ' h1
B2: =ProductsEntropy("Methane","SI",1450,1200,0.45,"PHI")       ' s1
B3: =ProductsTemperature("Methane","PS","SI",110,B2,0.45,"PHI") ' T2s ≈ 823 K
B4: =ProductsEnthalpy("Methane","SI",B3,110,0.45,"PHI")         ' h2s
B5: =B1-B4                                                       ' ideal work ≈ 780 kJ/kg
B6: =B5*0.9                                                      ' actual work at eta_s = 0.9
```

Turbine analysis with a known work output and isentropic efficiency (note the sign convention: h2s = h1 − W_t/η_t, which lies *below* the actual exit enthalpy):

```
h1  = ProductsEnthalpy("JP5","SI",T1,P1,r,"PHI")
s1  = ProductsEntropy("JP5","SI",T1,P1,r,"PHI")
h2  = h1 - Wt
h2s = h1 - Wt/eta_t
P2  = ProductsPressure("JP5","HS","SI",h2s,s1,r,"PHI")
T2  = ProductsTemperature("JP5","PH","SI",P2,h2,r,"PHI")
```

A dew-point guard raises an error if water in the products would condense (relevant below ~330 K for near-stoichiometric mixtures), and product thermodynamics use NASA 7-term polynomials valid to 3500 K. Note the model is *frozen-composition*: above ~1600 K, equilibrium codes such as NASA CEA report slightly higher effective cp (~2-3 % at 1700 K) because they include shifting dissociation (NO, OH). For turbine expansion the frozen assumption is generally the physically appropriate one, since those recombination reactions are kinetically slow in a real exhaust.

### Validating against other tools

Pure-fluid functions: compare against the **NIST WebBook** (free, browser-based, reference-quality isotherm/saturation tables) or **CoolProp** (free, open-source Helmholtz-EOS library with Python/Excel/MATLAB wrappers); NIST also offers **mini-REFPROP**, a free demo of the real thing with a limited fluid set. Combustion products: **Cantera** (free Python library; build a CO2/H2O/N2/O2/Ar mixture at your computed mole fractions and compare h, s, cp) or **NASA CEA** for equilibrium composition and flame temperatures. Air-standard cross-checks against Keenan & Kaye-style gas tables are also a quick sanity test at low pressure.

## Troubleshooting

- **`#NAME?`** — the script isn't saved in this spreadsheet's Apps Script project. Repeat the install steps in this exact sheet.
- **`Loading...` that never resolves** — Google throttles very large numbers of simultaneous custom-function calls. Break huge tables into chunks or paste values for completed sections.
- **Error text in a cell** — read it; the functions throw descriptive messages (unknown fluid, T above critical, quality out of range, property undefined in two-phase, etc.).
- **Slow recalculation** — each cell is an independent Apps Script call (~50–200 ms). A few hundred property cells are fine; tens of thousands are not. Consider computing intermediate columns and pasting as values.
