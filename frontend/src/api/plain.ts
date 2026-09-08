/* Plain-English glosses.
 *
 * The manifest gives every layer a correct scientific label and its source
 * instrument. Neither tells a person who is not a meteorologist what they are
 * looking at, and "Outgoing longwave radiation, INSAT-3D L2" is a label that
 * only works for someone who already knew.
 *
 * So every layer, every regime and every status gets one sentence in ordinary
 * words. The sentence is shown next to the technical label rather than instead
 * of it: a forecaster still needs "OLR, INSAT-3D L2", and a judge still needs
 * to know it means "where the tallest, coldest storm clouds are".
 *
 * These are descriptions of what the quantity is, not claims about what
 * TRINETRA found. Nothing here asserts a result.
 */

export const LAYER_PLAIN: Record<string, string> = {
  insat_ir:
    "How cold the cloud tops are. Colder means taller clouds, and taller " +
    "clouds mean stronger thunderstorms. This is the classic satellite " +
    "cyclone picture.",
  insat_wv:
    "Moisture in the middle of the atmosphere. Dry air pushing into a storm " +
    "tends to weaken it.",
  insat_vis:
    "What the storm looks like in ordinary daylight. Blank at night, because " +
    "there is no sunlight to reflect.",
  insat_olr:
    "How much heat escapes to space. Where little escapes, deep storm cloud " +
    "is blocking it — so low values mark the most active convection.",
  insat_qpe:
    "How hard it is raining right now, estimated from the satellite.",
  insat_sst:
    "How warm the sea surface is. Warm water is the fuel; below about 26 °C a " +
    "cyclone struggles to keep going.",
  insat_uth:
    "Humidity high in the atmosphere, above the storm.",
  insat_aod:
    "Dust and haze in the air column. Context rather than a cyclone signal.",
  pmw_89:
    "A microwave view that sees through the cirrus canopy to the rain and ice " +
    "underneath, which is where the real structure of the storm is.",
  pmw_37:
    "A lower microwave frequency, good for picking out the rain bands and the " +
    "warm core.",
  scat_wind:
    "Wind speed and direction measured at the ocean surface by radar, rather " +
    "than inferred from cloud pictures.",
  soil_moisture:
    "How wet the ground is. This is the channel that keeps working after the " +
    "storm crosses the coast and stops being a cyclone.",
  cmv_shear:
    "How much the wind changes with height, worked out from tracking clouds " +
    "at two levels in Indian satellite imagery. Strong change tears a storm " +
    "apart.",
  era5_shear:
    "How much the wind changes between high and low levels. Strong change " +
    "tilts and weakens a cyclone. This one comes from a weather model, not " +
    "from an instrument.",
  era5_rh_mid:
    "Mid-level humidity from a weather model. Dry air here starves a storm.",
  era5_divergence:
    "How much air is spreading out at the top of the storm. Good outflow lets " +
    "a cyclone strengthen.",
  tchp:
    "How much heat the ocean holds down to depth, not just at the surface. A " +
    "deep warm layer keeps feeding a storm even after it churns the sea.",
  districts: "District boundaries, for locating the rainfall risk on the ground.",
  coastline: "Coastline and land, so you can see where the sea ends.",

  tri_track_intensity:
    "The storm's path, coloured by how strong it was at each point.",
  tri_track_cone:
    "How far the centre could reasonably be from where we place it. The width " +
    "is a checked 90 percent range, not a guess.",
  tri_centre_uncertainty:
    "How precisely the eye is located at this moment.",
  tri_ri_favourability:
    "Where conditions favour rapid strengthening. This is TRINETRA's own " +
    "output, not an observation.",
  tri_ri_favourability_spread:
    "How much the model disagrees with itself about that. Wide means treat " +
    "the field above with caution.",
  tri_district_risk:
    "Rainfall risk band by district once the storm is inland. Bands, not a " +
    "smooth field, because the underlying accuracy does not support one.",
  tri_district_risk_confidence:
    "How confident the risk banding is, district by district.",
  tri_sensor_coverage:
    "Which instruments actually had a view of this area at this time.",
  tri_regime_segments:
    "Which phase the storm is in along its track: out at sea, being torn by " +
    "wind shear, over land, or a decaying remnant.",
  tri_regime_confidence: "How sure TRINETRA is about that phase.",
  tri_parametric_wind:
    "A reconstructed wind field around the storm, built from the estimated " +
    "peak wind. A model of the wind, not a measurement of it.",
  tri_parametric_wind_spread: "The uncertainty in that reconstruction.",
  tri_swath_history:
    "Where the passing satellites have actually looked recently, so you can " +
    "see the gaps.",
};

/** The four track phases, in ordinary words. */
export const REGIME_PLAIN: Record<string, string> = {
  maritime_mature: "Out at sea and organised",
  sheared: "Being pulled apart by high winds",
  post_landfall_remnant: "Inland leftovers, still raining",
  over_land: "Over land",
};

/** Why a value is missing, in ordinary words. */
export const STATUS_PLAIN: Record<string, string> = {
  ok: "measured",
  stale: "the last look was a while ago",
  expired: "too old to use",
  no_coverage: "nothing passed over this spot",
  no_data: "nothing recorded here",
  instrument_unavailable: "this instrument cannot see here now",
  out_of_domain: "outside the area being analysed",
};

/** The three provenance classes, in ordinary words. */
export const CLASS_PLAIN: Record<string, string> = {
  O: "What a satellite actually measured.",
  R: "A weather model's best reconstruction, used as an input. Not a measurement.",
  D: "TRINETRA's own output. Always shown with its uncertainty.",
};

export const CATEGORY_PLAIN: Record<string, string> = {
  D: "Depression — winds up to 33 kt",
  DD: "Deep depression — 34 to 47 kt",
  CS: "Cyclonic storm — 48 to 63 kt",
  SCS: "Severe cyclonic storm — 64 to 89 kt",
  VSCS: "Very severe cyclonic storm — 90 to 119 kt",
  ESCS: "Extremely severe cyclonic storm — 120 to 165 kt",
  SuCS: "Super cyclonic storm — above 166 kt",
};
