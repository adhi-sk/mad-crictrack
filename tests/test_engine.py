import pytest

from backend.engine import ScoringEngine
from backend.models import Match, Team


def make_engine(overs=2):
    match = Match(
        team_a=Team("Alpha"),
        team_b=Team("Beta"),
        overs_limit=overs,
    )
    engine = ScoringEngine(match)
    engine.start_innings(match.team_a, match.team_b)
    engine.set_openers("A1", "A2", "B1")
    return engine


def test_record_runs_and_batting_stats():
    engine = make_engine()
    engine.record_ball(runs=4)

    inn = engine.match.current_innings
    batter = engine.match.team_a.get_player("A1")
    bowler = engine.match.team_b.get_player("B1")

    assert inn.total_runs == 4
    assert inn.legal_balls_bowled == 1
    assert batter.runs == 4
    assert batter.fours == 1
    assert batter.balls_faced == 1
    assert bowler.balls_bowled == 1
    assert bowler.runs_conceded == 4


def test_wide_does_not_count_as_legal_ball():
    engine = make_engine()
    engine.record_ball(extra_type="wide", extra_runs=1)

    inn = engine.match.current_innings
    assert inn.total_runs == 1
    assert inn.legal_balls_bowled == 0


def test_no_ball_does_not_count_as_legal_ball():
    engine = make_engine()
    engine.record_ball(runs=2, extra_type="no_ball", extra_runs=1)

    inn = engine.match.current_innings
    batter = engine.match.team_a.get_player("A1")
    assert inn.total_runs == 3
    assert inn.legal_balls_bowled == 0
    assert batter.runs == 2


def test_six_does_not_swap_strike():
    engine = make_engine()
    engine.record_ball(runs=6)
    assert engine.striker == "A1"
    assert engine.non_striker == "A2"


def test_odd_run_swaps_strike():
    engine = make_engine()
    engine.record_ball(runs=1)
    assert engine.striker == "A2"
    assert engine.non_striker == "A1"


def test_six_legal_balls_end_over_and_require_new_bowler():
    engine = make_engine()
    for _ in range(6):
        engine.record_ball(runs=0)
    inn = engine.match.current_innings
    assert inn.legal_balls_bowled == 6
    assert len(inn.overs) == 1
    assert engine.bowler is None


def test_target_completes_chase():
    engine = make_engine(overs=2)
    engine.match.innings[0].is_complete = True
    engine.start_innings(engine.match.team_b, engine.match.team_a, target=2)
    engine.set_openers("Batter1", "Batter2", "A1")
    engine.record_ball(runs=2)

    assert engine.match.innings[1].is_complete is True
    engine.determine_result()
    assert engine.match.result == "Beta won by 10 wicket(s)"
