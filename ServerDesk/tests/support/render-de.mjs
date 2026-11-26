// renderToStaticMarkup inside a German LocaleProvider. Tests that check the
// German page import it in place of react-dom/server; the real hooks of
// ui/base/locale.tsx then use 'de', as for a German user. Without a
// provider the hooks fall back to defaultLocale (English).
import './register.mjs';
import React from 'react';
import {renderToStaticMarkup as render} from 'react-dom/server';

const {LocaleProvider} = await import('../../ui/base/locale.tsx');

export const renderToStaticMarkup = (node, options) => render(React.createElement(LocaleProvider, {locale: 'de'}, node), options);
