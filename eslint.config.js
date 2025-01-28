import base from '@arbendium/eslint-config-base';

export default [
	...base,
	{
		rules: {
			'no-underscore-dangle': 'off',
			'stylistic/max-len': 'off'
		}
	}
];
