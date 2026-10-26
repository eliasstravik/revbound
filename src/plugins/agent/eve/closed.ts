import { eveChannel } from "eve/channels/eve";

/**
 * eve's HTTP session API with the console chat turned off: an empty auth walk refuses every caller, Vercel OIDC tokens
 * and bypass headers included. The public health check and eve's callback routes keep working.
 */
export default eveChannel({ auth: [] });
