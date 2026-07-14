import test from 'node:test';
test('protected Supabase integration is opt-in', { skip: process.env.SUPABASE_TEST_PROJECT !== 'true' }, () => {});
