import { withRevbound } from "revbound/next";
import manifest from "./_revbound/manifest";
import transforms, { trace } from "./_revbound/next";

export default withRevbound({}, { manifest, transforms, trace });
