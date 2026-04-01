from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import garth
from garminconnect import Garmin


def json_error(message: str) -> None:
    print(json.dumps({"error": message}), file=sys.stderr)


def date_range(start: str, end: str) -> list[str]:
    current = datetime.strptime(start, "%Y-%m-%d").date()
    stop = datetime.strptime(end, "%Y-%m-%d").date()
    dates: list[str] = []

    while current <= stop:
        dates.append(current.isoformat())
        current += timedelta(days=1)

    return dates


def configure_oauth_consumer() -> None:
    key = os.getenv("GARTH_OAUTH_KEY", "").strip()
    secret = os.getenv("GARTH_OAUTH_SECRET", "").strip()

    if not key or not secret:
        return

    # The package README shows key/secret, while garth reads
    # consumer_key/consumer_secret. Set both to tolerate either shape.
    garth.sso.OAUTH_CONSUMER = {
        "key": key,
        "secret": secret,
        "consumer_key": key,
        "consumer_secret": secret,
    }


def resolve_tokenstore() -> str:
    return os.getenv("GARMINTOKENS", "~/.garminconnect").strip() or "~/.garminconnect"


def ensure_tokenstore_permissions(tokenstore_path: Path) -> None:
    tokenstore_path.mkdir(parents=True, exist_ok=True)

    try:
        os.chmod(tokenstore_path, 0o700)
    except OSError:
        pass

    for file_name in ("oauth1_token.json", "oauth2_token.json"):
        token_file = tokenstore_path / file_name
        if not token_file.exists():
            continue

        try:
            os.chmod(token_file, 0o600)
        except OSError:
            pass


def has_saved_tokens(tokenstore_path: Path) -> bool:
    return (
        (tokenstore_path / "oauth1_token.json").exists()
        and (tokenstore_path / "oauth2_token.json").exists()
    )


def build_client() -> Garmin:
    email = os.getenv("GARMIN_EMAIL")
    password = os.getenv("GARMIN_PASSWORD")
    tokenstore = resolve_tokenstore()

    configure_oauth_consumer()

    client = Garmin(email, password)

    if len(tokenstore) > 512:
        client.login(tokenstore=tokenstore)
        return client

    tokenstore_path = Path(tokenstore).expanduser()
    ensure_tokenstore_permissions(tokenstore_path)

    if has_saved_tokens(tokenstore_path):
        try:
            client.login(tokenstore=str(tokenstore_path))
            ensure_tokenstore_permissions(tokenstore_path)
            return client
        except Exception:
            # Fall back to a fresh credential login if cached tokens no longer work.
            pass

    if not email or not password:
        raise RuntimeError(
            "No valid Garmin tokens found. Run `npm run garmin:python:setup` to create ~/.garminconnect."
        )

    raise RuntimeError(
        "No valid Garmin tokens found. Run `npm run garmin:python:setup` to create ~/.garminconnect before starting the API."
    )


def safe_daily_range(
    dates: list[str],
    fetcher: Any,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for cdate in dates:
        try:
            rows.append({"date": cdate, "data": fetcher(cdate)})
        except Exception:
            rows.append({"date": cdate, "data": None})
    return rows


def call_tool(client: Garmin, name: str, args: dict[str, Any]) -> Any:
    if name == "get_user_profile":
        return client.get_user_profile()
    if name == "get_devices":
        return client.get_devices()
    if name == "get_daily_summary":
        return client.get_user_summary(args["date"])
    if name == "get_sleep_data_range":
        return safe_daily_range(
            date_range(args["startDate"], args["endDate"]),
            client.get_sleep_data,
        )
    if name == "get_hrv_range":
        return safe_daily_range(
            date_range(args["startDate"], args["endDate"]),
            client.get_hrv_data,
        )
    if name == "get_training_readiness_range":
        return safe_daily_range(
            date_range(args["startDate"], args["endDate"]),
            client.get_training_readiness,
        )
    if name == "get_daily_steps_range":
        return client.get_daily_steps(args["startDate"], args["endDate"])
    if name == "get_vo2max_range":
        return safe_daily_range(
            date_range(args["startDate"], args["endDate"]),
            lambda _: None,
        )
    if name == "get_training_status":
        return client.get_training_status(args["date"])
    if name == "get_race_predictions":
        return client.get_race_predictions(
            args.get("startDate"),
            args.get("endDate"),
            args.get("type"),
        )
    if name == "get_activities_by_date":
        return client.get_activities_by_date(
            args["startDate"],
            args["endDate"],
            args.get("activityType"),
        )
    if name == "get_body_composition":
        return client.get_body_composition(args["startDate"], args["endDate"])

    raise RuntimeError(f"Unsupported Garmin bridge command: {name}")


def main() -> int:
    if len(sys.argv) < 2:
        json_error("Command name is required")
        return 1

    command = sys.argv[1]
    raw_args = sys.argv[2] if len(sys.argv) > 2 else "{}"

    try:
        args = json.loads(raw_args)
    except json.JSONDecodeError as error:
        json_error(f"Invalid JSON args: {error}")
        return 1

    try:
        client = build_client()
        result = call_tool(client, command, args)
        print(json.dumps(result, ensure_ascii=True))
        return 0
    except Exception as error:
        json_error(str(error))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
