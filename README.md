This is a fork of [node-postgres](https://github.com/brianc/node-postgres) [pg](https://www.npmjs.com/package/pg). It's modernized and tailored for my needs. Legacy or otherwise unnecessary code has been removed. Indirections and many fallbacks (eg support for environment variables) have been removed. Code has been migrated to ESM and types have been added. Further modifications may and likely will be done.

The goal is to have a database driver which is significantly simpler, more stateless and transparent.

The package is not intended for a third-party use. No compatibility is guaranteed.
