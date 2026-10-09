// The editor's date and time (public/ui.js, used by views/editor.html):
// the 7 PM default for a new event, the typed-time parser, the month
// grid and its keys, the quarter-hour list, and the popover's markup.

const test = require('node:test');
const assert = require('node:assert/strict');
const UI = require('../public/ui.js');

test('a new event gets 7 PM once its day is picked; a chosen time and an edited event keep theirs', () => {
  assert.equal(UI.DEFAULT_START, '19:00');
  assert.equal(UI.startTimeFor(false, '2026-10-10', ''), '19:00');
  assert.equal(UI.startTimeFor(false, '2026-10-10', '07:57'), '07:57', 'a time someone chose stays');
  assert.equal(UI.startTimeFor(false, '', ''), '', 'no day, no time');
  assert.equal(UI.startTimeFor(true, '2026-10-10', '18:30'), '18:30', 'an event being edited keeps its time');
  assert.equal(UI.startTimeFor(true, '2026-10-10', ''), '', 'and never gets one filled in');
});

test('parseClock: what people type, as HH:MM', () => {
  const cases = [
    // With AM or PM.
    ['7:57 pm', '19:57'], ['7:57pm', '19:57'], ['7:57 PM', '19:57'], ['7:57 p.m.', '19:57'], ['757p', '19:57'],
    ['7p', '19:00'], ['7 pm', '19:00'], ['7am', '07:00'], ['7:05a', '07:05'], ['12am', '00:00'], ['12:30am', '00:30'],
    ['12pm', '12:00'], ['12:15 pm', '12:15'], ['11:59pm', '23:59'], ['1a', '01:00'],
    // 24-hour and with leading zeros: as written.
    ['19:57', '19:57'], ['1957', '19:57'], ['0:05', '00:05'], ['00:00', '00:00'], ['07:57', '07:57'], ['0757', '07:57'],
    ['23:59', '23:59'], ['13', '13:00'], ['12', '12:00'], ['0', '00:00'], ['19.57', '19:57'], ['19h57', '19:57'],
    ['noon', '12:00'], ['Midnight', '00:00'], ['  8:30  ', '08:30']
  ];
  for (const [text, want] of cases) assert.equal(UI.parseClock(text), want, text);
  // Bare 1 to 11, no AM or PM: the half of the day of the time it replaces.
  assert.equal(UI.parseClock('7:57', '19:00'), '19:57');
  assert.equal(UI.parseClock('757', '19:00'), '19:57');
  assert.equal(UI.parseClock('7', '19:00'), '19:00');
  assert.equal(UI.parseClock('7:57', '09:00'), '07:57');
  assert.equal(UI.parseClock('7:57'), '07:57', 'nothing to go by: as written');
  assert.equal(UI.parseClock('11:30', '12:00'), '23:30');
  assert.equal(UI.parseClock('12:30', '19:00'), '12:30', '12 is noon');
  assert.equal(UI.parseClock('07:57', '19:00'), '07:57', 'a leading zero is the morning');
  assert.equal(UI.parseClock('0:05', '19:00'), '00:05');
  assert.equal(UI.parseClock('19:57', '09:00'), '19:57');
  assert.equal(UI.parseClock('7:57am', '19:00'), '07:57', 'AM says so');
  // Not times.
  for (const junk of ['', '   ', 'soon', '7:5', '7:60', '24:00', '25', '75', '13pm', '0am', '0pm', '7:57 xm', '7::57', '12345', 'pm', '-1', '7:57pmm', null, undefined]) {
    assert.equal(UI.parseClock(junk, '19:00'), null, String(junk));
  }
});

test('monthGrid: six weeks from Sunday, with the days around the month', () => {
  const oct = UI.monthGrid(2026, 10);
  assert.equal(oct.length, 6);
  oct.forEach((week) => assert.equal(week.length, 7));
  // October 1, 2026 is a Thursday: four days of September first.
  assert.deepEqual(oct[0].map((d) => d.date), ['2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03']);
  assert.deepEqual(oct[0].map((d) => d.inMonth), [false, false, false, false, true, true, true]);
  assert.deepEqual(oct[0].map((d) => d.day), [27, 28, 29, 30, 1, 2, 3]);
  const days = oct.flat();
  assert.equal(days.filter((d) => d.inMonth).length, 31);
  assert.equal(days[days.length - 1].date, '2026-11-07');
  // Every day once, one after another (no doubled or missing day at a
  // daylight-saving change: November 1, 2026 in the US).
  for (let i = 1; i < days.length; i++) assert.equal(days[i].date, UI.addDays(days[i - 1].date, 1));
  assert.ok(days.some((d) => d.date === '2026-11-01'));
  // A month starting on Sunday has no leading days; February 2026 fits
  // in four weeks and gets two of March's.
  const feb = UI.monthGrid(2026, 2);
  assert.equal(feb[0][0].date, '2026-02-01');
  assert.equal(feb[4][0].date, '2026-03-01');
  assert.equal(feb[5][6].date, '2026-03-14');
  // A leap year's February, and across a year.
  assert.equal(UI.monthGrid(2028, 2).flat().filter((d) => d.inMonth).length, 29);
  assert.equal(UI.monthGrid(2027, 1)[0][0].date, '2026-12-27');
  // March 2026 (US clocks go forward on the 8th).
  const mar = UI.monthGrid(2026, 3).flat();
  assert.equal(mar.filter((d) => d.inMonth).length, 31);
  assert.equal(mar[7].date, '2026-03-08');
});

test('plain-date arithmetic and the calendar keys', () => {
  assert.equal(UI.addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(UI.addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(UI.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(UI.addDays('nope', 1), '');
  assert.equal(UI.addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(UI.addMonths('2028-01-31', 1), '2028-02-29');
  assert.equal(UI.addMonths('2026-12-15', 1), '2027-01-15');
  assert.equal(UI.addMonths('2026-01-15', -1), '2025-12-15');
  assert.equal(UI.addMonths('2026-10-10', 12), '2027-10-10');
  // Saturday, October 10, 2026.
  const d = '2026-10-10';
  assert.equal(UI.calendarMove(d, 'ArrowLeft'), '2026-10-09');
  assert.equal(UI.calendarMove(d, 'ArrowRight'), '2026-10-11');
  assert.equal(UI.calendarMove(d, 'ArrowUp'), '2026-10-03');
  assert.equal(UI.calendarMove(d, 'ArrowDown'), '2026-10-17');
  assert.equal(UI.calendarMove(d, 'PageUp'), '2026-09-10');
  assert.equal(UI.calendarMove(d, 'PageDown'), '2026-11-10');
  assert.equal(UI.calendarMove(d, 'PageDown', true), '2027-10-10');
  assert.equal(UI.calendarMove(d, 'Home'), '2026-10-04');
  assert.equal(UI.calendarMove(d, 'End'), '2026-10-10');
  assert.equal(UI.calendarMove('2026-10-04', 'Home'), '2026-10-04');
  assert.equal(UI.calendarMove(d, 'Enter'), null);
});

test('the time list: every quarter hour, and an odd minute in its place', () => {
  const all = UI.timeSlots('');
  assert.equal(all.length, 96);
  assert.equal(all[0], '00:00');
  assert.equal(all[all.length - 1], '23:45');
  assert.equal(all[77], '19:15');
  assert.equal(UI.timeSlots('19:00').length, 96, 'on the grid: not added twice');
  const odd = UI.timeSlots('19:57');
  assert.equal(odd.length, 97);
  assert.deepEqual(odd.slice(odd.indexOf('19:45'), odd.indexOf('19:45') + 3), ['19:45', '19:57', '20:00']);
  const html = UI.timeOptions('19:57');
  assert.match(html, /<li role="option" class="wp-opt" id="whenPopTime-1957" data-time="19:57" aria-selected="true">7:57 PM<\/li>/);
  assert.match(html, /<li role="option" class="wp-opt" id="whenPopTime-0000" data-time="00:00" aria-selected="false">12:00 AM<\/li>/);
  assert.equal((html.match(/aria-selected="true"/g) || []).length, 1);
  assert.equal((UI.timeOptions('').match(/aria-selected="true"/g) || []).length, 0);
});

test('the popover: a labelled dialog, a grid of days, a time field and a listbox', () => {
  const pop = UI.whenPopover();
  assert.match(pop, /^<div class="when-pop" id="whenPop" role="dialog" aria-label="Start date and time" hidden>/);
  assert.match(pop, /<table class="wp-grid" id="whenPopGrid" role="grid" aria-labelledby="whenPopMonth"><\/table>/);
  assert.match(pop, /<input type="text" id="whenPopTime" class="wp-time-input" placeholder="Type a time"/);
  assert.match(pop, /<label class="sr-only" for="whenPopTime">Time<\/label>/);
  assert.match(pop, /<ul class="wp-times" id="whenPopTimes" role="listbox" tabindex="0" aria-label="Times"><\/ul>/);
  assert.match(pop, /aria-label="Previous month"/);
  assert.match(pop, /aria-label="Next month"/);
  // No help text: no paragraphs, nothing under the field but its error.
  assert.ok(!/<p[ >]/.test(pop));

  assert.equal(UI.monthWords(2026, 10), 'October 2026');
  const grid = UI.calendarMonth(2026, 10, { selected: '2026-10-10', today: '2026-10-08', min: '2026-10-08', focus: '2026-10-10' });
  assert.match(grid, /^<thead><tr><th scope="col" abbr="Sunday"><span aria-hidden="true">S<\/span><\/th><th scope="col" abbr="Monday">/);
  assert.equal((grid.match(/role="gridcell"/g) || []).length, 42);
  assert.match(grid, /<td role="gridcell" aria-selected="true"><button type="button" class="wp-day" data-date="2026-10-10" tabindex="0" aria-label="Saturday, October 10, 2026">10<\/button><\/td>/);
  assert.match(grid, /<button type="button" class="wp-day today" data-date="2026-10-08" tabindex="-1" aria-label="Thursday, October 8, 2026" aria-current="date">8<\/button>/);
  // Before the first day that may be picked: dimmed, not pickable.
  assert.match(grid, /data-date="2026-10-07" tabindex="-1" aria-label="Wednesday, October 7, 2026" aria-disabled="true">7</);
  assert.match(grid, /class="wp-day out" data-date="2026-09-27" tabindex="-1" aria-label="Sunday, September 27, 2026" aria-disabled="true">27</);
  assert.match(grid, /class="wp-day out" data-date="2026-11-07" tabindex="-1" aria-label="Saturday, November 7, 2026">7</);
  assert.equal((grid.match(/tabindex="0"/g) || []).length, 1, 'one day takes Tab');
  assert.equal((grid.match(/aria-selected="true"/g) || []).length, 1);
  // An old event: nothing held back.
  assert.ok(!UI.calendarMonth(2026, 10, { selected: '2026-10-10', today: '2026-10-08', min: '' }).includes('aria-disabled'));
});

test('what the popover says is picked', () => {
  // dayWords leaves the year out for this year's days.
  const year = new Date().getFullYear();
  assert.equal(UI.pickedWords(year + '-10-10', '19:57'), UI.dayWords(year + '-10-10') + ' at 7:57 PM');
  assert.equal(UI.pickedWords('2031-10-10', '19:00'), 'Friday, October 10, 2031 at 7:00 PM');
  assert.equal(UI.pickedWords('2031-10-10', ''), 'Friday, October 10, 2031');
  assert.equal(UI.pickedWords('', '07:05'), '7:05 AM');
  assert.equal(UI.pickedWords('', ''), 'Pick a day and a time');
});
