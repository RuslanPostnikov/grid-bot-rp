import { BOT_EVENTS } from '@src/common/events.js';

describe('BOT_EVENTS', () => {
  it('has stable event name strings', () => {
    expect(BOT_EVENTS.ORDER_FILLED).toBe('grid.orderFilled');
    expect(BOT_EVENTS.BOT_RESUMED).toBe('bot.resumed');
  });
});
