/** Number of copper pieces in one gold piece, from the system config. */
export function cpPerGp() {
  return CONFIG.DND5E.currencies.cp?.conversion ?? 100;
}

/** Convert an amount in a given denomination to copper pieces. */
export function toCp(value, denomination = "gp") {
  const conv = CONFIG.DND5E.currencies[denomination]?.conversion ?? 1;
  return Math.round((Number(value) || 0) * cpPerGp() / conv);
}

export function gpToCp(gp) {
  return Math.round((Number(gp) || 0) * cpPerGp());
}

export function itemBaseCp(item) {
  const price = item.system?.price ?? {};
  return toCp(price.value ?? 0, price.denomination || CONFIG.DND5E.defaultCurrency || "gp");
}

/** Unit sale price in copper after markup and any haggle modifier for this visit. */
export function unitPriceCp(item, config, visit = null) {
  const base = itemBaseCp(item);
  const markup = (Number(config.markup) || 100) / 100;
  const haggle = 1 - ((Number(visit?.modifier) || 0) / 100);
  return Math.max(0, Math.round(base * markup * haggle));
}

/** Split copper into gp / sp / cp coin counts. */
export function splitCp(cp) {
  cp = Math.round(Number(cp) || 0);
  const per = cpPerGp();
  const cpPerSp = per / (CONFIG.DND5E.currencies.sp?.conversion ?? 10);
  const gp = Math.floor(cp / per);
  const sp = Math.floor((cp - gp * per) / cpPerSp);
  const rest = cp - (gp * per) - (sp * cpPerSp);
  return { gp, sp, cp: rest };
}

/** Format copper as "12 gp 5 sp 3 cp". */
export function formatCp(cp) {
  const { gp, sp, cp: rest } = splitCp(cp);
  const parts = [];
  if ( gp ) parts.push(`${gp} ${abbr("gp")}`);
  if ( sp ) parts.push(`${sp} ${abbr("sp")}`);
  if ( rest ) parts.push(`${rest} ${abbr("cp")}`);
  return parts.length ? parts.join(" ") : `0 ${abbr("gp")}`;
}

function abbr(denom) {
  const cfg = CONFIG.DND5E.currencies[denom];
  return game.i18n.localize(cfg?.abbreviation ?? denom);
}

/** Total wealth of an actor in copper. */
export function actorWealthCp(actor) {
  const currency = actor?.system?.currency ?? {};
  const per = cpPerGp();
  let total = 0;
  for ( const [denom, cfg] of Object.entries(CONFIG.DND5E.currencies) ) {
    if ( !cfg.conversion ) continue;
    total += (Number(currency[denom]) || 0) * (per / cfg.conversion);
  }
  return Math.round(total);
}

/** Deduct copper from an actor, making change across denominations. Throws if funds are insufficient. */
export async function deductCp(actor, cp) {
  cp = Math.round(cp);
  if ( cp <= 0 ) return actor;
  const insufficient = () => new Error(game.i18n.format("QUICKSHOP.Error.InsufficientFunds", { name: actor.name }));
  if ( actorWealthCp(actor) < cp ) throw insufficient();

  const Manager = globalThis.dnd5e?.applications?.CurrencyManager;
  if ( Manager?.getActorCurrencyUpdates ) {
    const { item, remainder, ...updates } = Manager.getActorCurrencyUpdates(actor, cp, "cp", {
      priority: "low", exact: true, makeChange: true
    });
    if ( remainder ) throw insufficient();
    return actor.update(updates);
  }

  // Fallback for older system versions: pay from the smallest coins first and break one larger coin for change.
  const per = cpPerGp();
  const currency = foundry.utils.deepClone(actor.system.currency);
  const denoms = Object.entries(CONFIG.DND5E.currencies)
    .filter(([, c]) => c.conversion)
    .sort((a, b) => b[1].conversion - a[1].conversion);
  let remaining = cp;
  for ( const [denom, cfg] of denoms ) {
    const valueCp = per / cfg.conversion;
    const use = Math.min(currency[denom], Math.floor(remaining / valueCp));
    currency[denom] -= use;
    remaining -= use * valueCp;
    if ( (remaining > 0) && (currency[denom] > 0) ) {
      currency[denom] -= 1;
      let change = valueCp - remaining;
      remaining = 0;
      for ( const [d2, c2] of denoms ) {
        const v2 = per / c2.conversion;
        if ( v2 >= valueCp ) continue;
        const n = Math.floor(change / v2);
        currency[d2] += n;
        change -= n * v2;
      }
    }
    if ( remaining <= 0 ) break;
  }
  if ( remaining > 0 ) throw insufficient();
  return actor.update({ "system.currency": currency });
}

/** Add copper to an actor's purse as gp / sp / cp coins. */
export async function addCp(actor, cp) {
  cp = Math.round(cp);
  if ( (cp <= 0) || !actor?.system?.currency ) return actor;
  const { gp, sp, cp: rest } = splitCp(cp);
  const c = actor.system.currency;
  return actor.update({
    "system.currency.gp": (c.gp ?? 0) + gp,
    "system.currency.sp": (c.sp ?? 0) + sp,
    "system.currency.cp": (c.cp ?? 0) + rest
  });
}
