// Shared by index.ts (which builds the actual privileged SSH connection) and
// registry.ts (which surfaces which account it runs as to the UI, via
// RedactedProfile.privilegedAs) so both agree on exactly where
// root_user/root_password live on a profile. Kept in its own module, rather
// than defined in either of those files and imported by the other, because
// index.ts already imports from registry.ts (profileId, redactProfile) --
// the other direction would be circular.

// Returns the connection option that actually reaches the managed host: the
// last element of a hop array, the hop object, or the top-level config when
// there is no hop. Mirrors sshClient.ts's own hop resolution exactly
// (_doConnect: connectOptions = Array.isArray(hop) ? [option].concat(hop) :
// [option, hop]; lastOption = connectOptions.pop()) -- in a hop/bastion
// profile the TOP-LEVEL host/username/password describe the first jump, not
// the destination, so root_user/root_password for the destination server
// live on the hop, not on the top level.
export function targetOption(config: any): any {
  const hop = config.hop;
  if (Array.isArray(hop) && hop.length > 0) {
    return hop[hop.length - 1];
  }
  if (hop && typeof hop === 'object' && Object.keys(hop).length > 0) {
    return hop;
  }
  return config;
}

// Both fields are required before switching lanes: an option carrying only
// root_user (a common half-finished edit) must not silently produce a
// connection that tries root with the ordinary user's password, locking the
// account out on hosts that count failed auths.
export function hasRootCreds(option: any): boolean {
  return Boolean(option.root_user && option.root_password);
}
