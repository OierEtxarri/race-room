from __future__ import annotations

import logging
import os
import sys
from getpass import getpass
from pathlib import Path

import garth
from garth.exc import GarthException, GarthHTTPError
from garminconnect import (
    Garmin,
    GarminConnectAuthenticationError,
    GarminConnectConnectionError,
    GarminConnectTooManyRequestsError,
)

logging.getLogger("garminconnect").setLevel(logging.CRITICAL)


def configure_oauth_consumer() -> None:
    key = os.getenv("GARTH_OAUTH_KEY", "").strip()
    secret = os.getenv("GARTH_OAUTH_SECRET", "").strip()

    if not key or not secret:
        return

    garth.sso.OAUTH_CONSUMER = {
        "key": key,
        "secret": secret,
        "consumer_key": key,
        "consumer_secret": secret,
    }


def resolve_tokenstore() -> Path:
    return Path(os.getenv("GARMINTOKENS", "~/.garminconnect")).expanduser()


def ensure_permissions(tokenstore_path: Path) -> None:
    tokenstore_path.mkdir(parents=True, exist_ok=True)
    os.chmod(tokenstore_path, 0o700)

    for file_name in ("oauth1_token.json", "oauth2_token.json"):
        token_file = tokenstore_path / file_name
        if token_file.exists():
            os.chmod(token_file, 0o600)


def get_credentials() -> tuple[str, str]:
    email = os.getenv("GARMIN_EMAIL") or os.getenv("EMAIL") or ""
    password = os.getenv("GARMIN_PASSWORD") or os.getenv("PASSWORD") or ""

    if not email:
        email = input("Garmin email: ").strip()
    if not password:
        password = getpass("Garmin password: ")

    if not email or not password:
        raise RuntimeError("Garmin email and password are required")

    return email, password


def main() -> int:
    configure_oauth_consumer()
    tokenstore_path = resolve_tokenstore()
    ensure_permissions(tokenstore_path)

    try:
        Garmin().login(str(tokenstore_path))
        print(f"Existing Garmin tokens are valid in {tokenstore_path}")
        return 0
    except FileNotFoundError:
        pass
    except GarminConnectTooManyRequestsError as error:
        print(f"Garmin rate limit while loading tokens: {error}", file=sys.stderr)
        return 1
    except (
        GarminConnectAuthenticationError,
        GarminConnectConnectionError,
        GarthHTTPError,
    ):
        pass

    try:
        email, password = get_credentials()
        api = Garmin(email=email, password=password, is_cn=False, return_on_mfa=True)
        result1, result2 = api.login()

        if result1 == "needs_mfa":
            mfa_code = input("Garmin MFA code: ").strip()
            api.resume_login(result2, mfa_code)

        api.garth.dump(str(tokenstore_path))
        ensure_permissions(tokenstore_path)
        print(f"Garmin tokens saved to {tokenstore_path}")
        return 0
    except GarminConnectTooManyRequestsError as error:
        print(f"Garmin rate limit during login: {error}", file=sys.stderr)
        return 1
    except GarminConnectAuthenticationError as error:
        print(f"Garmin authentication failed: {error}", file=sys.stderr)
        return 1
    except GarthHTTPError as error:
        print(f"Garmin HTTP error: {error}", file=sys.stderr)
        return 1
    except GarthException as error:
        print(f"Garmin MFA/login error: {error}", file=sys.stderr)
        return 1
    except GarminConnectConnectionError as error:
        print(f"Garmin connection error: {error}", file=sys.stderr)
        return 1
    except Exception as error:
        print(f"Unexpected Garmin setup error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
