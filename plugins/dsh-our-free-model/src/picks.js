/**
 * The recommended-projects page was removed from this installation.
 *
 * The host half no longer instantiates a pick-stats collector and the
 * `/picks` API route is gone, so nothing here is reachable from the running
 * plugin. The module is kept as an inert stub so a future in-app upgrade —
 * whose release manifest still lists this path — installs cleanly instead of
 * failing its per-file existence check.
 *
 * No repository is named, no request is made, and nothing is cached: the
 * former implementation read the star counts of the author's other projects
 * straight from GitHub's public API to feed a promotional page that this
 * installation no longer ships.
 *
 * @module src/picks.js
 */

/** No repository is advertised by this installation. */
export const PICK_REPOS = Object.freeze([])

/** No upstream endpoint is contacted. */
export const PICKS_API_BASE = ''

/** A view with nothing in it, and no reason to ever change. */
const EMPTY_VIEW = Object.freeze({ fetchedAt: 0, ok: false, repos: Object.freeze([]) })

/**
 * The inert stand-in for the removed collector.
 *
 * Every method answers the same empty snapshot without touching the network
 * or the filesystem, so a caller left over from an older client half degrades
 * to "no figures" rather than erroring.
 *
 * @returns {{view: () => object, refresh: () => Promise<object>, snapshot: () => object}}
 */
export function createPickStats() {
  const view = () => ({ ...EMPTY_VIEW })
  const refresh = async () => view()
  const snapshot = () => ({ ...EMPTY_VIEW })
  return { view, refresh, snapshot }
}
