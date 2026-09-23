"""Data models for the cricket scoring app."""
from dataclasses import dataclass, field
from typing import List, Optional


@dataclass
class Player:
    name: str
    runs: int = 0
    balls_faced: int = 0
    fours: int = 0
    sixes: int = 0
    is_out: bool = False
    out_description: str = ""

    # Bowling stats
    balls_bowled: int = 0
    runs_conceded: int = 0
    wickets: int = 0

    @property
    def strike_rate(self) -> float:
        return round((self.runs / self.balls_faced) * 100, 2) if self.balls_faced else 0.0

    @property
    def economy(self) -> float:
        overs = self.balls_bowled / 6
        return round(self.runs_conceded / overs, 2) if overs else 0.0


@dataclass
class Team:
    name: str
    players: List[Player] = field(default_factory=list)

    def get_player(self, name: str) -> Player:
        for p in self.players:
            if p.name.lower() == name.lower():
                return p
        player = Player(name=name)
        self.players.append(player)
        return player


@dataclass
class Delivery:
    bowler: str
    batsman: str
    runs: int = 0
    extra_type: Optional[str] = None  # 'wide', 'no_ball', 'bye', 'leg_bye'
    extra_runs: int = 0
    is_wicket: bool = False
    wicket_type: Optional[str] = None  # 'bowled', 'caught', 'run_out', etc.
    player_out: Optional[str] = None

    @property
    def is_legal(self) -> bool:
        return self.extra_type not in ("wide", "no_ball")

    @property
    def total_runs(self) -> int:
        return self.runs + self.extra_runs


@dataclass
class Over:
    number: int
    deliveries: List[Delivery] = field(default_factory=list)

    @property
    def runs(self) -> int:
        return sum(d.total_runs for d in self.deliveries)

    @property
    def legal_balls(self) -> int:
        return sum(1 for d in self.deliveries if d.is_legal)


@dataclass
class Innings:
    batting_team: str
    bowling_team: str
    overs_limit: int
    overs: List[Over] = field(default_factory=list)
    wickets: int = 0
    max_wickets: int = 10
    is_complete: bool = False
    target: Optional[int] = None  # set for the chasing innings

    @property
    def total_runs(self) -> int:
        return sum(o.runs for o in self.overs)

    @property
    def legal_balls_bowled(self) -> int:
        return sum(o.legal_balls for o in self.overs)

    @property
    def overs_completed_str(self) -> str:
        balls = self.legal_balls_bowled
        return f"{balls // 6}.{balls % 6}"

    @property
    def run_rate(self) -> float:
        balls = self.legal_balls_bowled
        return round((self.total_runs / balls) * 6, 2) if balls else 0.0

    def required_run_rate(self) -> Optional[float]:
        if self.target is None:
            return None
        balls_left = self.overs_limit * 6 - self.legal_balls_bowled
        runs_needed = self.target - self.total_runs
        if balls_left <= 0:
            return None
        return round((runs_needed / balls_left) * 6, 2)


@dataclass
class Match:
    team_a: Team
    team_b: Team
    overs_limit: int
    innings: List[Innings] = field(default_factory=list)
    result: Optional[str] = None

    @property
    def current_innings(self) -> Optional[Innings]:
        for inn in self.innings:
            if not inn.is_complete:
                return inn
        return None
