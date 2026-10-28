import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';

afterEach(() => cleanup());
// The product default is pt-BR since d46a9a5; the English suite pins 'en' so its
// text assertions stay valid. Files that test the default itself clear storage first.
beforeEach(() => localStorage.setItem('openvms.lang', 'en'));
