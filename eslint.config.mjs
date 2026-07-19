import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { FlatCompat } from '@eslint/eslintrc';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
    baseDirectory: __dirname
});

const eslintConfig = [
    {
        // The Apple Music service (./apple-music) is a self-contained submodule
        // with its own toolchain — keep it out of Tryptify's lint/type-check.
        ignores: ['apple-music/**']
    },
    ...compat.extends('next/core-web-vitals', 'next/typescript'),
    {
        rules: {
            '@typescript-eslint/no-explicit-any': 'off',
            '@next/next/no-img-element': 'off',
            '@next/next/no-sync-scripts': 'off',
            'react-hooks/exhaustive-deps': 'off'
        }
    }
];

export default eslintConfig;
