{
  description = "Pi Extensions development environment";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      devShells = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          # Keep Bun exact without moving the rest of the pinned development environment.
          bun = pkgs.bun.overrideAttrs (_: {
            version = "1.4.2";
            src = pkgs.fetchurl {
              url = "https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/${sources.${system}.archive}.zip";
              hash = sources.${system}.hash;
            };
          });
          sources = {
            aarch64-darwin = {
              archive = "bun-darwin-aarch64";
              hash = "sha256-kJh6OhbX21VtiGrD1VHnttPt8KHPQ6yu1iLoZ2vh0S8=";
            };
            aarch64-linux = {
              archive = "bun-linux-aarch64";
              hash = "sha256-VDKLvC2cjgyfiSxUTWbFeoO4QTnjSQnl7oF1jxrI/ac=";
            };
            x86_64-linux = {
              archive = "bun-linux-x64-baseline";
              hash = "sha256-xngEDxT+BEDrg503y9DOTAUaMtpygGrJfeamqra/co8=";
            };
          };
        in
        {
          default = pkgs.mkShell {
            packages = [
              bun
            ]
            ++ (with pkgs; [
              git
              hk
              nixd
            ]);
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
