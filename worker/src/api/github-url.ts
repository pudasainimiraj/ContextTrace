// The parser lives in shared/ so the web application can preview the parsed owner/name as the user types.
export { parseRepositoryInput, type ParseResult } from "../../../shared/github-url.ts";
