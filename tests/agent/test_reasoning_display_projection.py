from agent.agent_runtime_helpers import reasoning_repeats_visible_answer


def test_reasoning_equal_to_visible_answer_is_a_display_duplicate():
    assert reasoning_repeats_visible_answer("Final answer", "Final answer") is True
    assert reasoning_repeats_visible_answer("Final answer\r\n", "Final answer\n") is True


def test_distinct_reasoning_remains_visible():
    assert reasoning_repeats_visible_answer("genuine thought", "Final answer") is False
    assert reasoning_repeats_visible_answer("", "") is False
