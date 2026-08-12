{
  description = "Pi Extensions development environment";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      checks = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          pnpm = pkgs.pnpm_11;
        in
        {
          default = pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
            pname = "pi-extensions-check";
            version = "0.0.0";
            src = self;

            nativeBuildInputs = [
              pkgs.git
              pkgs.nodejs_22
              pkgs.unixtools.ps
              pnpm
              pkgs.pnpmConfigHook
            ];

            pnpmDeps = pkgs.fetchPnpmDeps {
              inherit (finalAttrs) pname version src;
              inherit pnpm;
              fetcherVersion = 4;
              hash = "sha256-YKnxfBXoZNOIrcugGvnwI3uxhM5Zv8QLuVTO7csMMr4=";
            };

            # A sandboxed Darwin build cannot write to the user's Keychain.
            NODE_OPTIONS = pkgs.lib.optionalString pkgs.stdenv.isDarwin "--test-skip-pattern=^Keychain storage works through the stdin-only security process$";

            buildPhase = ''
              runHook preBuild
              pnpm check
              runHook postBuild
            '';

            installPhase = ''
              runHook preInstall
              touch "$out"
              runHook postInstall
            '';
          });
        }
      );

      devShells = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              git
              hk
              nixd
              nodejs_22
              pnpm_11
              typescript-language-server
            ];

            shellHook = ''
              export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
            '';
          };
        }
      );

      formatter = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        pkgs.writeShellApplication {
          name = "nixfmt";
          runtimeInputs = [ pkgs.nixfmt ];
          text = ''
            if [ "$#" -eq 0 ]; then
              set -- flake.nix
            fi
            exec nixfmt "$@"
          '';
        }
      );
    };
}
