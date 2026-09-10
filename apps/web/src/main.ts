import '@fontsource-variable/dm-sans';
import '@fontsource-variable/manrope';
import { mount } from 'svelte';
import App from './App.svelte';
import './style.css';
mount(App, { target: document.getElementById('app')! });
