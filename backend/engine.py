"""Core scoring engine: ball-by-ball state management."""
from typing import Optional

from .models import Match, Team, Innings, Over, Delivery


class ScoringEngine:
    def __init__(self, match: Match):
        self.match = match
        self.striker: Optional[str] = None
        self.non_striker: Optional[str] = None
        self.bowler: Optional[str] = None

    # ---------- Innings setup ----------

    def start_innings(self, batting: Team, bowling: Team, target: Optional[int] = None):
        innings = Innings(
            batting_team=batting.name,
            bowling_team=bowling.name,
            overs_limit=self.match.overs_limit,
            target=target,
        )
        self.match.innings.append(innings)
        self.striker = None
        self.non_striker = None
        self.bowler = None

    def set_openers(self, striker: str, non_striker: str, bowler: str):
        self.striker = striker
        self.non_striker = non_striker
        self.bowler = bowler

    # ---------- Ball processing ----------

    def _batting_team(self) -> Team:
        inn = self.match.current_innings
        return self.match.team_a if inn.batting_team == self.match.team_a.name else self.match.team_b

    def _bowling_team(self) -> Team:
        inn = self.match.current_innings
        return self.match.team_a if inn.bowling_team == self.match.team_a.name else self.match.team_b

    def record_ball(
        self,
        runs: int = 0,
        extra_type: Optional[str] = None,
        extra_runs: int = 0,
        is_wicket: bool = False,
        wicket_type: Optional[str] = None,
        player_out: Optional[str] = None,
    ) -> Delivery:
        inn = self.match.current_innings
        if inn is None:
            raise RuntimeError("No active innings.")

        if not inn.overs or inn.overs[-1].legal_balls >= 6:
            inn.overs.append(Over(number=len(inn.overs) + 1))
        current_over = inn.overs[-1]

        delivery = Delivery(
            bowler=self.bowler,
            batsman=self.striker,
            runs=runs,
            extra_type=extra_type,
            extra_runs=extra_runs,
            is_wicket=is_wicket,
            wicket_type=wicket_type,
            player_out=player_out or (self.striker if is_wicket else None),
        )
        current_over.deliveries.append(delivery)

        self._apply_stats(delivery)
        self._rotate_strike(delivery)

        if is_wicket:
            inn.wickets += 1
            if delivery.player_out == self.striker:
                self.striker = None  # needs a new batsman
            elif delivery.player_out == self.non_striker:
                self.non_striker = None

        # End of over: swap strike, a new bowler is required
        if current_over.legal_balls == 6 and delivery.is_legal:
            self.striker, self.non_striker = self.non_striker, self.striker
            self.bowler = None

        self._check_innings_complete(inn)
        return delivery

    def _apply_stats(self, delivery: Delivery):
        batting = self._batting_team()
        bowling = self._bowling_team()

        bowler = bowling.get_player(delivery.bowler)
        if delivery.is_legal:
            bowler.balls_bowled += 1
        bowler.runs_conceded += delivery.total_runs

        # Byes/leg-byes aren't credited to the batsman; wides aren't a "ball faced"
        if delivery.extra_type != "wide":
            batsman = batting.get_player(delivery.batsman)
            batsman.balls_faced += 1
            if delivery.extra_type not in ("bye", "leg_bye"):
                batsman.runs += delivery.runs
                if delivery.runs == 4:
                    batsman.fours += 1
                if delivery.runs == 6:
                    batsman.sixes += 1

        if delivery.is_wicket and delivery.wicket_type != "run_out":
            bowler.wickets += 1

        if delivery.is_wicket:
            out_player = batting.get_player(delivery.player_out)
            out_player.is_out = True
            out_player.out_description = f"{delivery.wicket_type} b {delivery.bowler}"

    def _rotate_strike(self, delivery: Delivery):
        # Calculate runs physically completed between wickets
        if delivery.extra_type in ("wide", "no_ball"):
            # The 1 extra run is a penalty; only additional runs (extra_runs - 1) were physically run
            physical_runs = delivery.runs + max(0, delivery.extra_runs - 1)
        elif delivery.extra_type in ("bye", "leg_bye"):
            physical_runs = delivery.extra_runs
        else:
            physical_runs = delivery.runs

        # Boundaries (4 or 6) never rotate strike
        if delivery.runs in (4, 6):
            return

        if physical_runs % 2 == 1:
            self.striker, self.non_striker = self.non_striker, self.striker

    def _check_innings_complete(self, inn: Innings):
        balls_bowled = inn.legal_balls_bowled
        overs_done = balls_bowled >= inn.overs_limit * 6
        all_out = inn.wickets >= inn.max_wickets
        target_reached = inn.target is not None and inn.total_runs >= inn.target

        if overs_done or all_out or target_reached:
            inn.is_complete = True

    # ---------- New players ----------

    def new_batsman(self, name: str, at_striker: bool = True):
        if at_striker:
            self.striker = name
        else:
            self.non_striker = name

    def new_bowler(self, name: str):
        self.bowler = name

    # ---------- Result ----------

    def determine_result(self):
        if len(self.match.innings) < 2:
            return
        first, second = self.match.innings[0], self.match.innings[1]
        if second.total_runs > first.total_runs:
            margin = 10 - second.wickets
            self.match.result = f"{second.batting_team} won by {margin} wicket(s)"
        elif first.total_runs > second.total_runs:
            margin = first.total_runs - second.total_runs
            self.match.result = f"{first.batting_team} won by {margin} run(s)"
        else:
            self.match.result = "Match tied"
