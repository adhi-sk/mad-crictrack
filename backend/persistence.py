"""Save and load match state as JSON."""
import json
from dataclasses import asdict
from pathlib import Path

from .models import Match, Team, Innings, Over, Delivery, Player


def save_match(match: Match, path: str):
    Path(path).write_text(json.dumps(asdict(match), indent=2))


def load_match(path: str) -> Match:
    data = json.loads(Path(path).read_text())

    def build_team(d):
        return Team(name=d["name"], players=[Player(**p) for p in d["players"]])

    team_a = build_team(data["team_a"])
    team_b = build_team(data["team_b"])

    innings_list = []
    for inn_d in data["innings"]:
        overs = []
        for over_d in inn_d["overs"]:
            deliveries = [Delivery(**dd) for dd in over_d["deliveries"]]
            overs.append(Over(number=over_d["number"], deliveries=deliveries))
        inn_d = dict(inn_d)
        inn_d["overs"] = overs
        innings_list.append(Innings(**inn_d))

    return Match(
        team_a=team_a,
        team_b=team_b,
        overs_limit=data["overs_limit"],
        innings=innings_list,
        result=data.get("result"),
    )
