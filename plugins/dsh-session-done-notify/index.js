/**
 * Host half of the session-done-notify bundle.
 *
 * The capability lives entirely in the Client half (`./client.js`): the
 * `api-session/status` Host event is already forwarded to every connected
 * page by the application's Remote assembly, so the browser half can watch
 * running -> idle transitions and show a Web Notification (native toast on
 * Windows, system notification on Android) without any Host-side wiring.
 */
export function apply() {}
