# Run Local Transcribe on a server

Use Docker with the Compose plugin. Run these commands from the repository root.

## Quick start

```sh
umask 077
cp deploy/.env.example .env
# Edit LT_ADMIN_EMAIL and LT_ADMIN_PASSWORD in .env.
docker compose up -d
docker compose ps
```

Open `http://localhost:8080` on the Docker host. The app port is bound to loopback. Sign in with the bootstrap credentials. The server creates this account only when the database has no users. Once you have signed in, remove both bootstrap variables from `.env` and run `docker compose up -d` again. Use **Settings → Users** to invite local accounts and **Settings → Models** to download a shared Whisper model.

Run `docker compose up -d --build` to build from the checkout. The CPU image supports Linux amd64 and arm64. On amd64, whisper.cpp uses an AVX2 baseline.

## HTTPS

Browsers require a secure context for microphone access, with an exception for localhost. For remote access, use HTTPS and set `LT_PUBLIC_URL` to the exact browser origin so the server sets `Secure` session cookies and can validate login origins. Use a URL without a trailing slash, for example `https://transcribe.example.com`.

For the included Caddy proxy, point the domain's DNS at the Docker host, allow inbound ports 80 and 443, and set `LT_DOMAIN=transcribe.example.com` and `LT_PUBLIC_URL=https://transcribe.example.com` in `.env`. Caddy obtains and renews the certificate. An existing HTTPS proxy can also forward to the app's loopback port.

```sh
docker compose --profile https up -d
```

## OpenID Connect

At your provider, create a confidential web client using the authorization code flow. Register the exact redirect URI, for example `https://transcribe.example.com/auth/oidc/callback`. Configure `LT_PUBLIC_URL`, `LT_OIDC_ISSUER`, `LT_OIDC_CLIENT_ID` and `LT_OIDC_CLIENT_SECRET` in `.env`, or enter the OIDC settings under **Settings → Sign-in**. Environment settings take precedence. Restart or recreate the app with `docker compose up -d` after editing `.env`.

The default scopes are `openid email profile`. Set `LT_OIDC_ADMIN_GROUP` to the group value that should grant admin access. `LT_OIDC_GROUPS_CLAIM` defaults to `groups`. To limit who can sign in, set `LT_OIDC_ALLOWED_GROUPS` or `LT_OIDC_ALLOWED_DOMAINS` to comma-separated values. Confirm that an admin can sign in with SSO before setting `LT_LOCAL_LOGIN=false`.

| Provider | Client and issuer | Groups and access |
| --- | --- | --- |
| Keycloak | Enable client authentication and Standard flow. Use `https://sso.example.com/realms/<realm>` as the issuer. | Add a Group Membership mapper for the `groups` ID token claim. Disable **Full group path** to send values such as `lt-admins`. |
| Authentik | Create a confidential OAuth2/OpenID provider and application. Copy the issuer from provider discovery, typically `https://sso.example.com/application/o/<slug>/`. | Add a scope mapping that includes group names in `groups`. If it uses a separate `groups` scope, add that scope to `LT_OIDC_SCOPES`. Assign eligible users to the application. |
| Microsoft Entra ID | Register a Web app and create a client secret. For one tenant, use `https://login.microsoftonline.com/<tenant-id>/v2.0`. | Add a groups claim to the ID token under **Token configuration**. Use the group object IDs for group values and ensure the token includes the required memberships. |
| Google | Create a Web application OAuth client. Use `https://accounts.google.com` as the issuer. | Use the OAuth app's Workspace access controls or `LT_OIDC_ALLOWED_DOMAINS` to restrict sign-in. Manage admin roles in Local Transcribe. |

### Keycloak demo only

The demo uses Keycloak `start-dev` and public test credentials. Use disposable accounts and data. Give it a second DNS name pointing to the same Caddy host, for example `sso-demo.example.com`. With HTTPS for the app already configured, add these values to `.env` using your demo hostname.

```dotenv
LT_KEYCLOAK_DOMAIN=sso-demo.example.com
LT_OIDC_ISSUER=https://sso-demo.example.com/realms/local-transcribe
LT_OIDC_CLIENT_ID=local-transcribe
LT_OIDC_CLIENT_SECRET=local-transcribe-demo-secret
LT_OIDC_PROVIDER_NAME=Keycloak
LT_OIDC_ADMIN_GROUP=lt-admins
LT_OIDC_ALLOWED_GROUPS=lt-admins,lt-users
```

```sh
docker compose -f docker-compose.yml -f deploy/keycloak/docker-compose.yml \
  --profile https --profile sso-demo up -d
```

The realm imports the callback URL from `LT_PUBLIC_URL`. Sign in first as `lt-admin` / `demo-admin-password`, then as `lt-user` / `demo-user-password`. Use a different email for any local bootstrap account. Keycloak imports the realm on first creation. If the app's URL changes, update the client redirect in Keycloak or recreate the disposable Keycloak container.

## Backup and restore

Stop `app` before backing up `/data` so the archive captures a consistent set of databases and recordings. It includes accounts, shared models, recordings, transcripts, settings, and the generated `secret.key`. If you supply `LT_SECRET_KEY`, keep a secure copy of the same key separately. Store the archive and deployment configuration securely.

```sh
umask 077
docker compose stop app
docker compose run --rm --no-deps -T --entrypoint tar app -C /data -czf - . > lt-data.tar.gz
docker compose start app
```

To restore, stop the original stack and restore into an empty volume. This example uses a new Compose project to get a clean `lt-data` volume. Use the same app version and encryption key as the backup, then upgrade separately.

```sh
docker compose -p lt-restored run --rm --no-deps -T --entrypoint tar app -C /data -xzf - < lt-data.tar.gz
docker compose -p lt-restored up -d
```

Use the same Compose files and profiles for ongoing operations, including `--profile https` when using Caddy. If you replace the named volume with a bind mount, make its directory writable by UID/GID `10001`.

## Upgrade

Back up `/data` first. Pull the new image and recreate the app while keeping the volume. Pin `app.image` to a version tag if you need control over the upgrade version.

```sh
docker compose pull app
docker compose up -d app
docker compose logs --tail=50 app
```

## NVIDIA GPU

The CUDA image supports Linux amd64. Install a host NVIDIA driver compatible with CUDA 12.8 and configure the NVIDIA Container Toolkit for Docker. With Compose v2.30 or newer, apply the GPU override to use the CUDA build of whisper.cpp and expose the GPUs to the app container.

```sh
docker compose -f docker-compose.yml -f deploy/docker-compose.gpu.yml up -d
```

Add `--build` to compile locally, or use `<version>-cuda` to pin the GPU image. The app uses the same `/data` volume when switching between CPU and CUDA. Diarization runs on CPU in both images.
