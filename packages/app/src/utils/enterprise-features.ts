/**
 * A capability the admin has to grant, not one they have to remember to revoke.
 *
 * A distribution writes every switch, so a missing key means the build was made
 * before the surface existed and the operator never opted in. A managed build
 * also has a window before its manifest resolves, and one after it fails; that
 * gap is not a grant either. Only an explicit `true` from the console opens a
 * surface. An unmanaged build keeps everything (see the enterprise context).
 */
export function managedFeatureGranted(features: Record<string, boolean> | undefined, name: string) {
  return features !== undefined && features[name] === true
}
