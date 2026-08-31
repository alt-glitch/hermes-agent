import { describe, expect, test } from 'vitest'

import type { TodoSnapshot } from '../logic/store.ts'
import { headerText, overflowText, visibleRows } from '../view/todoPanel.tsx'

describe('todo panel nested row contract', () => {
  test('keeps DFS indentation while counts and overflow remain based on the whole snapshot', () => {
    const snapshot: TodoSnapshot = {
      counts: { cancelled: 1, completed: 2, in_progress: 1, pending: 7, total: 11 },
      todos: [
        { content: 'root', id: 'root', status: 'in_progress' },
        { content: 'child', id: 'child', parent: 'root', status: 'pending' },
        { content: 'grandchild', id: 'grand', parent: 'child', status: 'pending' },
        { content: 'sibling', id: 'sibling', parent: 'root', status: 'pending' },
        { content: 'root two', id: 'root-2', status: 'pending' },
        { content: 'root three', id: 'root-3', status: 'pending' },
        { content: 'root four', id: 'root-4', status: 'pending' },
        { content: 'root five', id: 'root-5', status: 'pending' },
        { content: 'done one', id: 'done-1', status: 'completed' },
        { content: 'done two', id: 'done-2', status: 'completed' },
        { content: 'cancelled', id: 'cancelled', status: 'cancelled' }
      ]
    }

    const rows = visibleRows(snapshot)
    expect(rows.map(([todo, depth]) => [todo.id, depth])).toEqual([
      ['root', 0],
      ['child', 1],
      ['grand', 2],
      ['sibling', 1],
      ['root-2', 0]
    ])
    expect(headerText(snapshot)).toBe('11 tasks · 2 done, 1 in progress, 7 open, 1 cancelled')
    expect(overflowText(snapshot, rows.length)).toBe('… +3 more open, 2 completed, 1 cancelled')
  })
})
