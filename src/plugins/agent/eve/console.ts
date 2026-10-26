/**
 * eve's HTTP session API (/eve/v1/*) as the console chat: open to exactly the people who may open the console
 * (access.ts), each a principal of their own, so approvals stay with whoever asked. The public health check and
 * eve's callback routes, which check their own tokens, keep working.
 */
import { ForbiddenError, type AuthFn } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";
import { isHosted } from "revbound/kit";
import { failClosed } from "revbound/proxy";
import { consoleCaller } from "../access.js";

export const consoleAuth: AuthFn<Request> = async (req) => {
  const caller = consoleCaller(req);
  if (!caller.ok) throw new ForbiddenError({ message: caller.error });
  if (isHosted() && (await failClosed(req))) throw new ForbiddenError({ message: "Turn on Vercel Authentication → All Deployments to use the chat." });
  return { authenticator: "revbound-console", principalType: "user", principalId: caller.principalId, attributes: caller.attributes };
};

export default eveChannel({ auth: [consoleAuth] });
