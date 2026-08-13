package com.cookietodo.app;

import com.getcapacitor.BridgeActivity;
import com.cookietodo.plugin.alarm.CookietodoAlarmPlugin;
import java.util.ArrayList;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Register the custom alarm plugin
        registerPlugin(CookietodoAlarmPlugin.class);
    }
}