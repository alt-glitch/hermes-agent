from agent.agent_runtime_helpers import reasoning_repeats_visible_answer
from agent.turn_finalizer import _last_visible_reasoning_for_turn


def test_reasoning_equal_to_visible_answer_is_a_display_duplicate():
    assert reasoning_repeats_visible_answer("Final answer", "Final answer") is True
    assert reasoning_repeats_visible_answer("Final answer\r\n", "Final answer\n") is True
    assert reasoning_repeats_visible_answer("Final answer\r", "Final answer\n") is True


def test_distinct_reasoning_remains_visible():
    assert reasoning_repeats_visible_answer("genuine thought", "Final answer") is False
    assert reasoning_repeats_visible_answer("", "") is False


def test_transformed_final_still_drops_reasoning_equal_to_provider_answer():
    messages = [
        {"role": "user", "content": "question"},
        {
            "role": "assistant",
            "content": "Provider answer",
            "reasoning": "Provider answer",
        },
    ]

    assert (
        _last_visible_reasoning_for_turn(messages, "[transformed] Provider answer")
        is None
    )


def test_duplicate_provider_answer_falls_back_to_earlier_genuine_reasoning():
    messages = [
        {"role": "user", "content": "question"},
        {"role": "assistant", "content": "", "reasoning": "genuine thought"},
        {"role": "tool", "content": "result"},
        {
            "role": "assistant",
            "content": "Provider answer",
            "reasoning": "Provider answer",
        },
    ]

    assert (
        _last_visible_reasoning_for_turn(messages, "[transformed] Provider answer")
        == "genuine thought"
    )
